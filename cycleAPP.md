# cycleAPP — 프로젝트 사양서 (Build Spec)

> 이 문서는 Cursor의 Agent가 읽고 그대로 구현하기 위한 사양서입니다.
> 한 번에 전부 만들지 말고, 아래 **개발 단계(Phase)** 순서대로 진행하세요.
> 모르는 부분은 추측하지 말고 사용자에게 물어보세요.

---

## 1. 개요

아이폰용 **사이클링 컴퓨터 앱**. 가민 Edge처럼 자전거 거치대에 폰을 놓고, 라이딩 중 실시간 데이터를 보고, 종료 후 기록 파일을 만들어 스트라바에 올린다.

- **플랫폼**: iOS (아이폰) 전용. 본인 1명만 사용. 앱스토어 배포 안 함(개인 설치).
- **프레임워크**: Flutter (Dart)
- **사용자 장비**:
  - 파워미터: **Favero Assioma** (BLE) — 파워 + 케이던스를 함께 송출
  - 심박계: BLE 심박 벨트/밴드 (Heart Rate Service 표준)
  - 속도/거리/경로: 아이폰 GPS
  - 경사도: 아이폰 내장 기압계(barometer)

---

## 2. 핵심 요구사항

1. BLE로 **아시오마(파워·케이던스)** 와 **심박계** 연결
2. **한 번 연결한 센서는 다음 실행 시 자동 재연결** (기기 ID 저장 → 앱 시작 시 자동 스캔·연결)
3. 실시간 표시: **현재 파워(W), 속도(km/h), 케이던스(rpm), 심박(bpm), 경사도(%), 주행거리(km), 운동시간**
4. 시작/일시정지/종료 컨트롤
5. 종료 시 **TCX 파일** 생성 (파워·심박·케이던스·GPS·고도 포함)
6. 생성한 파일을 **스트라바에 업로드** (무료 구독이므로 기본은 "파일 내보내기 → 수동 업로드" 방식. API 자동 업로드는 옵션, 아래 9장 참고)
7. 거치대 사용 대비: **화면 항상 켜짐**, 백그라운드에서도 GPS·BLE 유지

---

## 3. 기술 스택 / 패키지

```yaml
# pubspec.yaml 의존성 (버전은 설치 시점 최신으로 Agent가 확인)
dependencies:
  flutter_blue_plus:      # BLE 센서 연결
  geolocator:             # GPS 위치/속도/거리, 백그라운드 위치
  shared_preferences:     # 연결한 센서 기기 ID 영구 저장 (자동 재연결용)
  wakelock_plus:          # 화면 항상 켜짐
  path_provider:          # 파일 저장 경로
  share_plus:             # iOS 공유 시트로 TCX 파일 내보내기
  intl:                   # 시간/숫자 포맷
  # 기압계(경사도)는 아래 4-5 참고 (sensors_plus 또는 플랫폼 채널)
```

- **상태관리**: 단순하므로 `provider` 또는 `ValueNotifier`/`ChangeNotifier`로 충분. 과하게 설계하지 말 것.
- iOS 기압계는 `CMAltimeter`(CoreMotion)를 써야 정확. Flutter 패키지가 부족하면 **MethodChannel로 네이티브(Swift) 연동**.

---

## 4. 기능 상세

### 4-1. BLE: 아시오마 (파워 + 케이던스)

- **Service UUID**: `0x1818` (Cycling Power Service)
- **Characteristic**: `0x2A63` (Cycling Power Measurement) — notify 구독
- **파싱 (리틀 엔디안)**:
  1. `flags` (uint16) — 첫 2바이트
  2. `instantaneous_power` (sint16) — 다음 2바이트 = **현재 파워(W)**
  3. `flags`의 **bit 5 (Crank Revolution Data Present)** 가 1이면:
     - `cumulative_crank_revolutions` (uint16)
     - `last_crank_event_time` (uint16, 단위 1/1024초)
     - → 두 값의 직전 샘플 대비 차이로 **케이던스(rpm)** 계산:
       ```
       cadence_rpm = (Δcrank_revs) / (Δcrank_event_time / 1024) * 60
       ```
     - **롤오버 처리 필수**: 두 값 모두 65536에서 0으로 넘어감. 음수 델타면 +65536 보정.
     - Δrev == 0 (페달 멈춤)이면 케이던스 0 처리, 0으로 나누기 방지.
- 참고: 아시오마는 표준 CPS라 케이던스 센서를 따로 둘 필요 없음.

### 4-2. BLE: 심박계

- **Service UUID**: `0x180D` (Heart Rate Service)
- **Characteristic**: `0x2A37` (Heart Rate Measurement) — notify 구독
- **파싱**:
  1. `flags` (uint8) — 첫 1바이트, **bit 0** = HR 값 포맷(0=uint8, 1=uint16)
  2. bit 0 == 0 이면 다음 1바이트가 심박, == 1 이면 다음 2바이트(uint16, 리틀엔디안)가 심박

### 4-3. 자동 재연결 (중요)

- 사용자가 처음 센서를 고르면 `device.remoteId` 를 `shared_preferences`에 저장
  - 키 예: `saved_power_sensor_id`, `saved_hr_sensor_id`
- **앱 시작 시**:
  1. 저장된 ID가 있으면 → 자동으로 스캔 시작
  2. 스캔 결과에서 해당 remoteId가 보이면 → 자동 connect → 서비스 검색 → notify 구독
  3. 사용자 조작 없이 백그라운드로 진행, UI엔 "연결됨/연결 중/끊김" 상태만 표시
- **연결 끊김 대응**: `device.connectionState` 스트림 구독 → disconnected 감지 시 자동 재연결 재시도(지수 백오프 또는 5초 간격 재시도)
- iOS는 백그라운드 BLE 동작에 제약이 있으니, 라이딩 중엔 앱을 포그라운드 유지 권장(거치대 사용 시나리오와 일치).

### 4-4. GPS: 속도 / 거리 / 경로

- `geolocator`의 `getPositionStream` 으로 위치 갱신 구독 (`LocationAccuracy.best`, distanceFilter 0)
- **속도**: GPS의 `position.speed`(m/s) → km/h 변환. 야외 라이딩 기준 충분.
- **거리**: 직전 좌표와 현재 좌표 간 거리(`Geolocator.distanceBetween`) 누적.
- 정지/저속 시 GPS 노이즈로 거리가 튀는 것 방지: 속도 1km/h 미만이거나 이동거리 1m 미만이면 누적 제외(임계값 튜닝).

### 4-5. 경사도 (기압계 기반)

- iOS `CMAltimeter.startRelativeAltitudeUpdates` 로 **상대 고도 변화(m)** 를 받음 (Swift, MethodChannel로 Flutter에 전달).
- **경사도(%)** = (Δ고도 / Δ수평거리) × 100
  - 짧은 구간은 노이즈가 크므로 **이동평균(예: 최근 10~20m 또는 3~5초)** 으로 평활화.
- 기압계는 절대 고도가 아니라 **변화량**만 주므로, GPS 시작 고도를 기준점으로 잡거나 상대값으로만 사용.
- (대비책) 기기에서 기압계 사용 불가 시 GPS 고도로 폴백하되, 경사도 정확도 낮음을 UI에 표시.

### 4-6. UI / 화면 구성

- **메인 라이딩 화면** (큰 숫자, 거치대에서 잘 보이게):
  - 상단: 운동시간 / 주행거리
  - 큰 글씨로 **파워**, **속도** 강조
  - 그 아래 케이던스 / 심박 / 경사도
  - 센서 연결 상태 아이콘(파워·심박 각각)
  - 시작 / 일시정지 / 종료 버튼
- 디자인: 어두운 배경 + 고대비 큰 폰트(직사광 가독성). 야외 라이딩 고려.
- 라이딩 화면 진입 시 `WakelockPlus.enable()`, 종료 시 `disable()`.

---

## 5. 데이터 기록

- 라이딩 시작 → 종료까지 **1초 간격**으로 trackpoint 누적:
  ```
  TrackPoint {
    time: DateTime (UTC, ISO8601)
    lat, lon: double?      // GPS
    altitude: double?      // 기압계 기반 고도(또는 GPS 고도)
    distance: double       // 누적 거리(m)
    speed: double          // m/s
    power: int?            // W
    cadence: int?          // rpm
    heartRate: int?        // bpm
  }
  ```
- 메모리에 List로 쌓고, 종료 시 파일로 직렬화.

---

## 6. TCX 파일 생성

스트라바가 TCX의 파워(Watts)·심박·케이던스·고도·거리를 모두 읽으므로 **TCX(XML)** 로 출력. (FIT은 바이너리라 1차 범위 제외, 추후 옵션)

- 루트: `<TrainingCenterDatabase>`, `<Activities><Activity Sport="Biking">`
- 각 trackpoint는 `<Trackpoint>` 안에:
  - `<Time>` ISO8601 UTC
  - `<Position><LatitudeDegrees/><LongitudeDegrees/></Position>`
  - `<AltitudeMeters>`, `<DistanceMeters>`
  - `<HeartRateBpm><Value>` (심박)
  - `<Cadence>` (케이던스, 0~254)
  - 파워는 확장 필드:
    ```xml
    <Extensions>
      <ns3:TPX xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
        <ns3:Watts>{power}</ns3:Watts>
        <ns3:Speed>{speed_mps}</ns3:Speed>
      </ns3:TPX>
    </Extensions>
    ```
- 파일명 예: `cycleAPP_yyyyMMdd_HHmm.tcx`
- `path_provider`로 앱 문서 디렉터리에 저장.

---

## 7. 스트라바 업로드 (무료 구독 = 파일 방식)

> 사용자는 스트라바 **무료 구독**이며 "파일만 업로드"할 용도. 스트라바 API 자동 업로드는 정책상 유료 구독이 필요할 수 있으므로 **기본 경로는 파일 내보내기**로 한다.

- **기본(권장) 흐름**:
  1. 종료 시 생성한 TCX 파일을 `share_plus`의 iOS **공유 시트**로 띄움
  2. 사용자가 파일 앱에 저장하거나 AirDrop/메일로 PC에 보냄
  3. 브라우저에서 `strava.com/upload/select` 로 수동 업로드
- 앱 안에 "스트라바 업로드 방법" 간단 안내 텍스트 추가.

---

## 8. iOS 권한 (Info.plist)

다음 키를 반드시 추가:

- `NSBluetoothAlwaysUsageDescription` — BLE 센서 연결
- `NSLocationWhenInUseUsageDescription` — GPS 기록
- `NSLocationAlwaysAndWhenInUseUsageDescription` — 백그라운드 위치(필요 시)
- `NSMotionUsageDescription` — 기압계/모션 센서(경사도)
- `UIBackgroundModes`: `bluetooth-central`, `location` (백그라운드 유지)

---

## 9. (옵션 / Phase 4) 스트라바 API 자동 업로드

> 사용자가 추후 유료 구독으로 전환하고 "자동 업로드"를 원하면 구현. 지금은 만들지 말 것.

- 스트라바 개발자 사이트에서 앱 등록 → Client ID / Secret
- OAuth 2.0 (`activity:write` 스코프), iOS는 `ASWebAuthenticationSession` 사용
- **토큰 영구 저장** → refresh token으로 자동 갱신 → 한 번 인증 후 매번 자동 업로드
- 업로드 엔드포인트로 TCX 전송
- 주의: 정책상 개발자/사용자의 활성 스트라바 구독이 요구될 수 있음. AI 학습·분석 목적의 데이터 사용은 금지(업로드 용도는 무관).

---

## 10. 개발 단계 (이 순서로 구현)

- **Phase 1 — 센서 + 실시간 화면**
  flutter_blue_plus로 아시오마(파워·케이던스)·심박 연결, 숫자 실시간 표시. GPS 속도·거리, 기압계 경사도 붙이기. 화면 항상 켜짐.
- **Phase 2 — 자동 재연결**
  기기 ID 저장, 앱 시작 시 자동 스캔·연결, 끊김 시 재시도.
- **Phase 3 — 기록 + TCX 생성 + 공유**
  1초 단위 trackpoint 기록 → 종료 시 TCX 파일 생성 → 공유 시트로 내보내기.
- **Phase 4 (옵션)** — 스트라바 API 자동 업로드 (유료 전환 시).

각 Phase 끝나면 멈추고 사용자에게 실제 센서로 테스트 결과를 확인받은 뒤 다음 Phase 진행.

---

## 11. 주의사항 / 함정

- **BLE 테스트는 실기기 필수**. 시뮬레이터에선 블루투스/기압계/GPS 동작 안 함. 반드시 실제 아이폰 + 아시오마 + 심박계로 테스트.
- 파워 특성 파싱은 flags 비트에 따라 필드 오프셋이 바뀜 — bit 5 외 다른 옵션 필드가 앞에 올 수 있으니 **flags 비트 순서대로 오프셋 누적** 처리(스펙 준수).
- 케이던스 계산의 **시간/카운터 롤오버(65536)** 누락이 가장 흔한 버그. 반드시 처리.
- 거치대 장시간 사용 → 배터리 소모 큼. (앱 책임은 아니지만 README에 보조배터리 권장 명시)
- GPS 고도는 출렁임이 심함 → 경사도는 가급적 기압계 우선.

---

## 12. 산출물

- 동작하는 Flutter iOS 프로젝트 `cycleAPP`
- 실기기 빌드/설치 방법 README
- TCX 샘플 출력 1개(테스트 라이딩 기준)

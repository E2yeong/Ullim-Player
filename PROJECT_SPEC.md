# Ullim — 재현/재구축 명세서

> 앱 이름은 **Ullim**(울림)이지만, GitHub 저장소는 처음 만들었을 때 이름 그대로
> `E2yeong/music-player-pro`를 계속 쓰고 있다 (저장소 이름 변경은 별도로 하지 않음).
> `package.json`의 `name`/`productName`은 `ullim`/`Ullim`, `appId`는 `com.local.ullim`.

이 문서는 이 프로젝트를 처음부터 다시 만들어야 할 때(다른 PC, 다른 이름, 다른 저장소 등) 참고할 수 있도록
기능·아키텍처·설정 방법을 정리한 문서입니다. 코드를 직접 읽지 않아도 이 문서만 보고 동일한 앱을
재구성할 수 있는 것을 목표로 합니다.

## 1. 한 줄 요약

로컬 mp3/mp4 파일을 재생하는 Windows 데스크톱 앱(Electron). 좌측 아이콘 레일 + 탭(목록/재생/EQ/설정)
구조의 메인 창, 플레이리스트, 반복/셔플, 8밴드 그래픽 EQ, 리버브, 항상 위에 뜨는 미니 플레이어(오버레이),
시스템 트레이 백그라운드 재생, 설정 자동 저장/복원, GitHub Releases 기반 자동 업데이트를 갖춤.

## 2. 기술 스택

- **Electron** (`electron`, `electron-builder`) — 데스크톱 앱 셸, Windows NSIS 인스톨러 빌드
- **순수 JS/HTML/CSS** — 프레임워크 없음 (React/Vue 등 미사용), 렌더러는 vanilla DOM 조작
- **Web Audio API** — `<video>` 엘리먼트를 오디오 소스로 사용해 mp3/mp4 모두 처리, EQ/리버브/리미터는
  `AudioContext` 그래프로 구성
- **electron-updater** — GitHub Releases(비공개 저장소)를 피드로 사용하는 자동 업데이트
- **GitHub CLI(`gh`)** — 저장소 생성, 릴리스 업로드/공개에 사용 (사람이 미리 `gh auth login` 해둬야 함)

## 3. 폴더 구조

```
Music_pro/                # 로컬 프로젝트 폴더명(디스크상 이름). 앱 표시 이름은 Ullim.
  package.json          # electron-builder 설정(build 필드) 포함
  update-token.txt       # (git에 없음) private repo 읽기 전용 fine-grained PAT, 로컬에만 존재
  build/
    icon.ico              # 앱 아이콘 (창/트레이/설치파일 아이콘 전부 이 파일 하나로 사용)
  assets/
    Ullim_intro.mp4        # 실행 시 재생되는 인트로 영상 (git에 커밋됨, extraResources로 배포)
  src/
    main.js               # Electron 메인 프로세스 (창 생성, IPC, 트레이, 자동 업데이트, 설정 파일 I/O)
    preload.js             # 메인 창용 contextBridge API (window.api)
    preload-overlay.js      # 오버레이 창용 contextBridge API (window.overlayApi)
    preload-splash.js       # 인트로 영상 창용 contextBridge API (window.splashApi)
    renderer/
      index.html            # 좌측 아이콘 레일 + 4개 탭(목록/재생/EQ/설정) + 하단 고정 트랜스포트 바
      style.css
      renderer.js          # 메인 창 전체 로직 (탭 전환, 재생, 플레이리스트, EQ, 설정 저장/복원, 업데이트 UI)
    overlay/
      index.html
      overlay.css
      overlay.js           # 항상 위 미니 플레이어 로직
    splash/
      index.html
      splash.js             # 인트로 영상 재생, 종료/건너뛰기 시 메인 창에 바통 전달
```

## 4. 핵심 기능 (동작 방식 포함)

### 4.1 재생 / 플레이리스트
- `<video>` 태그 하나로 mp3/mp4/wav/ogg/m4a/flac/webm 재생. mp4가 아니면 커버 아트 오버레이(♪ 아이콘)를
  씌워 검은 화면 대신 보여줌 (`videoWidth === 0`이면 오디오로 간주).
- 파일 경로는 `file:///...` 로 변환해 `mediaEl.src`에 대입 (공백/한글 등은 `encodeURI` 처리).
- 이전/다음/반복(끄기→전체→한곡 순환)/셔플, 재생목록 클릭 재생, 개별 삭제, 전체 삭제, 드래그 앤 드롭 추가.
- 좌측 사이드바에 여유 있는 밀도의 리스트(번호 / 제목 / 길이)로 표시 (§4.12 "정석안" 참고 — 한때 검색창
  달린 촘촘한 표 형태였다가, "여유 있는 밀도"로 되돌림).
- 길이(재생시간)는 파일을 재생하지 않고도 표시하기 위해, 트랙이 추가될 때마다 화면에 붙이지 않는
  `<video preload="metadata">`를 하나 만들어 `loadedmetadata`에서 duration만 읽고 버리는 방식으로
  비동기 조회함 (`probeDuration()`). DOM에 붙이지 않는 엘리먼트라 GC가 로딩 중에 수거해갈 수 있어,
  로딩이 끝날 때까지 `Set`에 참조를 붙잡아둠. 조회된 `durationSec`은 `state.tracks`의 트랙 객체에 그대로
  얹혀서 설정 파일에도 같이 저장되므로, 한 번 조회된 곡은 다음 실행부터 다시 조회하지 않음.

### 4.2 EQ / 리버브 (Web Audio 그래프)
신호 경로:
```
MediaElementSource
  → [8개 BiquadFilter 직렬: 60Hz(lowshelf), 150, 400, 1K, 2.5K, 6K, 12K, 16Hz(highshelf)]
  → dryGain(0.92 고정) ─┐
  → ConvolverNode(wetGain) ┴→ masterGain → DynamicsCompressor(리미터) → destination
```
- 각 밴드 게인 범위: **-36dB ~ +36dB**
- 리버브: `ConvolverNode.buffer`는 1.4초 길이의 랜덤 노이즈를 decay 지수로 감쇠시켜 즉석 생성(외부 IR 파일
  없음). `wetGain`은 슬라이더 0~100%를 **그대로** wet 게인(0~1)에 매핑 (100%까지 완전 반영).
  dry는 항상 0.92로 고정 — **리버브를 올려도 원음 볼륨이 줄지 않도록** 하기 위함 (초기 버전 버그: dry를
  `1 - wet*0.6`으로 깎아서 리버브 올릴수록 전체 음량이 작아지고 먹먹해졌던 문제를 고침).
- 리미터(DynamicsCompressor): threshold -10dB, knee 4, ratio 20:1, attack 3ms, release 250ms.
  ±36dB 부스트를 여러 밴드에 동시에 걸어도 하드클리핑되지 않도록 하는 안전장치.
- EQ 프리셋 4종(Flat/Bass Boost/Vocal/Hall Reverb)은 8개 밴드 게인 배열 + reverb% 값의 조합으로 정의.

### 4.3 오버레이(미니 플레이어)
- 별도의 frameless, `alwaysOnTop: true` (level `'screen-saver'`), `transparent: true` BrowserWindow.
- `resizable: true`, `minWidth/minHeight/maxWidth/maxHeight` 지정, 우하단에 시각적 리사이즈 그립 표시
  (실제 리사이즈는 OS 창 경계 드래그로 동작, 그립은 장식용).
- 위치/크기는 `player-settings.json`의 `overlayBounds`에 저장되어 다음에 열 때 복원됨. 모니터 구성이
  바뀌어도 화면 밖으로 나가지 않도록 `workArea` 기준으로 clamp.
- 메인 창과는 IPC로 상태를 주고받음 (재생 여부, 곡 제목, 볼륨, 재생 위치/길이) — 오버레이에서 버튼을
  누르면 커맨드를 메인 창에 보내고, 메인 창이 실제 재생을 제어한 뒤 상태를 다시 브로드캐스트.
- 진행바 포함 (탐색 가능): 메인 창이 재생 중 500ms 간격으로 `currentTime/duration`을 브로드캐스트.

### 4.4 시스템 트레이 (백그라운드 재생)
- 창의 X(닫기) 버튼을 누르면 기본적으로 **종료가 아니라 숨김**(`e.preventDefault(); mainWindow.hide()`).
  이 동작은 "설정" 탭의 "닫아도 트레이에 상주" 토글로 끌 수 있음 — 꺼져 있으면 `close` 이벤트에서
  `preventDefault()`를 호출하지 않아 평범하게 종료됨. 매번 닫을 때마다 `readSettingsFile()`을 새로 읽어
  판단하므로 앱을 재시작하지 않고 설정만 바꿔도 바로 반영됨.
- 실제 종료는 트레이 메뉴의 "종료"(`app.isQuitting = true; app.quit()`)나 `before-quit` 이벤트를 통해서만.
- 트레이 메뉴: 열기 / 재생·일시정지 / 다음 곡 / 이전 곡 / 종료. 트레이 아이콘 클릭 시 창 show/focus.
- 창이 숨겨져 있어도 렌더러 프로세스는 계속 살아있으므로 재생은 백그라운드에서 계속되고, 오버레이로
  계속 제어 가능.

### 4.5 설정 자동 저장/복원
- 저장 위치: `app.getPath('userData')/player-settings.json` (Windows: `%APPDATA%\<productName 소문자>\`)
- 저장 항목: `tracks`(경로+이름+`durationSec` 배열), `currentIndex`, `repeatMode`, `shuffle`, `eqEnabled`,
  `waveformEnabled`, `currentPreset`(마지막으로 적용한 EQ 프리셋 key, 수동으로 슬라이더를 만지면 `null`),
  `trayOnClose`/`introEnabled`/`autoUpdateCheck`(§4.12 설정 탭 토글 3종), `volume`,
  `eq: { bands: number[8], reverb: number }`, `overlayBounds`.
- `trayOnClose`/`introEnabled`/`autoUpdateCheck`는 렌더러 쪽에는 UI 상태 표시 말고 다른 효과가 없고,
  **메인 프로세스(`main.js`)가 설정 파일을 직접 읽어** 동작을 바꾼다 — 별도 IPC 채널을 두지 않고, 그때그때
  `readSettingsFile()`을 호출해 최신 값을 읽는 방식 (창 닫기 핸들러, 스플래시 창 생성 직전, 앱 시작 시
  각각 한 번씩).
- **읽기-수정-쓰기(read-modify-write) 병합** 방식 (`writeSettingsFile`) — 렌더러가 부분 정보만 저장해도
  메인 프로세스가 직접 저장하는 `overlayBounds` 같은 필드를 덮어쓰지 않도록 항상 기존 파일을 읽어 병합
  후 저장.
- 앱 시작 시 저장된 트랙 경로 중 실제로 존재하지 않는 파일은 자동으로 목록에서 제외 (`fs.existsSync`).
- **이름 변경 시 마이그레이션 필요**: `userData` 경로는 `package.json`의 `name` 필드를 따라가므로
  (`%APPDATA%\<name>`), 앱 이름을 바꾸면(`music-player-pro` → `ullim`) 예전 설정 파일을 못 찾게 된다.
  `migrateOldSettingsIfNeeded()`가 새 경로에 파일이 없을 때만 옛 폴더(`music-player-pro`)의
  `player-settings.json`을 한 번 복사해 옴 — 이름을 또 바꾸게 되면 이 함수의 옛 경로도 갱신할 것.
- 렌더러의 각 상태 변경 지점(EQ 슬라이더, 볼륨, 반복/셔플, 트랙 추가/삭제/재생)마다 400ms 디바운스로
  저장, 창 종료(`beforeunload`) 시 즉시 flush.

### 4.6 자동 업데이트 (electron-updater + GitHub Releases, private repo)
- **왜 private repo인가**: 개인용 프로젝트라 코드 비공개 유지. 단, private repo면 electron-updater가
  API 인증 토큰을 요구함.
- **토큰 취급 원칙**: 넓은 권한의 개인 `gh` 로그인 토큰을 앱에 박아넣지 않고, **Fine-grained PAT**를
  발급해서 사용 — 대상 저장소 단 하나, `Contents: Read-only` 권한만 부여. 이 토큰 값은:
  - 절대 git에 커밋하지 않음 (`update-token.txt`를 `.gitignore`에 등록)
  - electron-builder의 `extraResources`로 패키징된 앱의 `resources/update-token.txt`에 포함시켜 배포
  - 메인 프로세스가 앱 시작 시 파일에서 읽어 `autoUpdater.setFeedURL({ provider:'github', owner, repo,
    private:true, token })`로 전달
  - **중요한 함정**: `electron-updater`는 private GitHub repo 인증 토큰을 `autoUpdater.requestHeaders`가
    아니라 **`setFeedURL()`의 `token` 필드**로 받아야 인식한다 (내부적으로 `PrivateGitHubProvider`를
    선택하는 조건이 `providerFactory.js`에서 `data.private`이고 `GH_TOKEN`/`GITHUB_TOKEN` 환경변수 또는
    `data.token`이 있을 때임). `requestHeaders`로만 설정하면 조용히 공개용(GitHubProvider, 인증 없음)
    provider로 폴백되어 private repo에서 404가 난다.
- **업데이트 확인 흐름**: 메인 창의 "업데이트 확인" 버튼 → `checkForUpdates()` → available이면 버튼이
  "vX.X.X 다운로드"로 바뀜 → 클릭 시 `downloadUpdate()` → 완료되면 "재시작 후 설치" → `quitAndInstall()`.
  개발 모드(`app.isPackaged === false`)에서는 업데이트 확인을 하지 않고 안내 메시지만 표시.
- **시작 시 자동(조용한) 확인**: "설정" 탭의 "자동 업데이트 확인" 토글이 켜져 있으면(기본값), 패키징된
  앱은 `app.whenReady()` 직후 `autoUpdater.checkForUpdates()`를 한 번 더 호출한다. 수동 버튼과 완전히
  같은 `autoUpdater` 이벤트(`checking-for-update`/`update-available`/...)를 그대로 타므로 렌더러 쪽에는
  새 IPC나 분기 없이 동일하게 반영됨 — "자동으로 조용히 확인"이라는 문구와 달리 실제로는 수동 확인과
  똑같이 상태 UI가 갱신되는데, 새 버전이 없으면 어차피 "최신 버전입니다" 정도라 눈에 띄지 않을 뿐임.

### 4.7 실행 시 인트로 영상
- "설정" 탭의 "시작할 때 인트로 영상" 토글이 꺼져 있으면 `createSplashWindow()`가 스플래시 창을 아예
  만들지 않고 곧바로 `onDone()`을 호출해 메인 창을 보여줌 — 인트로 관련 코드 경로 자체를 건너뜀.
- 앱이 콜드 스타트할 때(트레이에서 창을 다시 열 때는 X) `assets/Ullim_intro.mp4`를 재생하는 별도의
  frameless 스플래시 창을 먼저 띄움. 메인 창은 `show:false`로 미리 생성해두고, 영상이 끝나거나
  ("ended"/"error" 이벤트) 사용자가 "건너뛰기"를 누르면 스플래시 창을 닫고 메인 창을 보여줌.
- 영상이 20초 안에 끝나지 않으면(코덱 문제 등) 안전장치 타이머로 자동으로 건너뜀.
- 영상 파일은 `app.asar` 안에 넣으면 `<video src="file://...">` 로 재생이 안 될 수 있어(ASAR는 진짜
  디렉터리가 아니라서 Chromium의 미디어 로더가 직접 못 읽음) **asar 밖의 `extraResources`**로 배포함
  (`update-token.txt`와 같은 방식). 스플래시 창은 `data:` URL이 아니라 실제 `loadFile()`로 정적
  `src/splash/index.html`을 불러오고, 영상 경로는 `get-intro-video-url` IPC로 받아온다
  (`data:` URL은 오리진이 분리되어 `file://` 리소스를 못 불러올 수 있어서 피함).

### 4.8 EQ 확장 히스토리 (참고)
1. 처음엔 Bass/Mid/Treble 3밴드, ±15dB — "악기별 자동 부스트/감쇠" 요청이 있었으나, 주파수 대역 기반
   EQ는 그 대역의 모든 소리(보컬 포함)에 동일하게 적용되어 보컬도 같이 줄어드는 한계가 있어 **실시간
   AI 음원 분리(악기별 감지)는 채택하지 않음** — 대신 8밴드로 세분화.
2. 최종: 8밴드(60/150/400/1K/2.5K/6K/12K/16K), ±36dB, 리버브 최대 100% wet, 리미터로 안전장치.

### 4.9 파형(waveform) 비주얼라이저 — 앱 이름("울림")을 시각화한 시그니처 기능
- `masterGain`에서 `AnalyserNode`(fftSize 512, smoothing 0.8)를 탭으로 분기 연결 (오디오 경로 자체에는
  영향 없음, 시각화 전용). 주파수 데이터(`analyserData`, 전체 레벨용)와 시간 도메인 데이터
  (`waveformData`, 파형 모양용)를 둘 다 사용.
- **모양은 위/아래로 미러링된 리본이 아니라 단일 파형** — 바닥에서 솟아오르는 하나의 곡선(산맥
  실루엣 느낌)이다. `getByteTimeDomainData()`를 `WAVE_POINTS`(48)개 구간으로 나눠 각 구간의 최대
  진폭을 뽑고, 그 값을 "envelope" 배열에 저장 — 새 값이 크면 즉시 튀어오르지만 작으면
  `WAVE_DECAY`(0.93)씩만 감쇠시켜서 **파형이 순간적으로 사라지지 않고 잔상처럼 오래 남도록** 만듦
  (맨 처음엔 매 프레임 즉시 사라지는 원형 ripple 이었다가 "더 오래갔으면"이라는 피드백으로 감쇠 방식
  으로 바꿨고, 그 다음엔 이 envelope을 위/아래로 미러링해 리본처럼 그렸다가 "2갈래로 갈라져 보인다"는
  피드백을 받고 최종적으로 지금의 단일 곡선 형태가 됨). `tracePath()`로 부드러운 곡선
  (`quadraticCurveTo`)을 그린 뒤 바닥까지 내려와 닫힌 도형으로 채우고, 보라색 그라데이션 + glow +
  위쪽 가장자리에만 밝은 stroke를 얹어 그림.
- 커버아트 영역(`#coverArt`)에 `<canvas>`로 그려짐. 오디오 전용 재생 시엔 항상 이 영역이 보이고,
  mp4 재생 시엔 기본적으로 실제 영상이 보임 — **단, `#btnWaveToggle`(스테이지) 또는 설정 페이지의
  파형 토글을 사용자가 실제로 한 번이라도 클릭하면, 그 세션 동안은 그 마지막 선택(on/off)이 영상보다
  우선한다** (`userToggledWaveform` 세션 변수, 저장되지 않음 — 앱을 다시 켜면 mp4는 항상 자기 영상부터
  보여주는 기본값으로 돌아옴). 그냥 저장된 `waveformEnabled:true`가 기본값이라고 해서 mp4를 열자마자
  영상이 파형으로 가려지면 안 되기 때문에 이렇게 분리함 — `state.waveformEnabled` 자체는 여전히
  "파형을 그릴지"만 뜻하고, `userToggledWaveform && state.waveformEnabled`가 "영상 대신 파형을 보여줄지"
  를 결정한다. 두 버튼(스테이지의 🌊, 설정의 토글) 모두 클릭 시 `userToggledWaveform = true`를 세팅한
  뒤 `setWaveformEnabled()`를 호출한다 — `setWaveformEnabled()` 자체(설정 복원 시에도 호출됨)는 이
  플래그를 건드리지 않아서, 저장된 설정을 불러오는 것만으로는 영상이 가려지지 않는다.
- `mediaEl`의 `play`/`pause` 이벤트로 `requestAnimationFrame` 루프를 시작/정지 (재생 중이 아닐 때는
  그리지 않아 CPU 낭비 없음, `waveformEnabled`가 꺼져 있으면 애초에 시작 안 함).
- 오버레이의 작은 점(dot)도 같은 컨셉으로 동기화됨: 전체 레벨을 100ms 간격으로 별도의 가벼운 IPC
  채널(`player-level-update`→`level-update`)로 오버레이에 전달해서 `transform: scale()` + 글로우로
  박동시킴. 곡 제목/진행률 등을 담는 무거운 `player-state-update`와 분리해서 빈도를 높게 유지.

### 4.10 오버레이 EQ/리버브 미니 패널
- 오버레이를 세로로 크게 리사이즈하면(`window.innerHeight >= 260`) 숨겨져 있던 8밴드 미니 EQ +
  리버브 슬라이더가 나타남 (`.panel.expanded` 클래스 토글, `window`의 `resize` 이벤트로 감지).
  이 때문에 오버레이 최대 높이(`OVERLAY_MAX_HEIGHT`)를 320→420으로 늘림.
- 밴드 주파수/범위(±36dB)는 메인 창의 `EQ_BANDS`와 반드시 일치시켜야 함 — 빌드 시스템이 없어 상수를
  `src/overlay/overlay.js`에도 그대로 복붙해둔 상태라, 메인 쪽 EQ 대역을 바꾸면 여기도 같이 고칠 것.
- 양방향 동기화: 오버레이에서 슬라이더를 움직이면 `overlay-command`(`eq-band`/`eq-reverb`)로 메인에
  전달되어 실제 EQ에 반영되고, 메인 창에서 슬라이더를 움직이면 `broadcastState()`가 `eq:{bands,reverb}`를
  포함해 오버레이에 다시 뿌려줌 — 두 방향 다 빠짐없이 `broadcastState()`를 호출하도록 되어 있는지 주의
  (한쪽만 빠뜨리면 창이 떠 있는 동안 서로 다른 값을 보여주는 버그가 남).

### 4.11 알려진 버그(해결됨): 트레이 아이콘이 투명하게 보이던 문제
- **진짜 원인**: `build/` 폴더는 electron-builder가 exe/설치파일 아이콘을 만들 때만 쓰는 폴더라서,
  **패키징된 앱에는 아예 포함되지 않는다.** 그런데 `createTray()`가 런타임에
  `path.join(__dirname, '..', 'build', 'icon.ico')`를 직접 읽으려고 했으니, 설치된 앱에서는 그 경로에
  파일이 없어 `nativeImage`가 빈 이미지를 반환 → `Tray`가 빈(투명한) 아이콘으로 뜸. 개발 모드(`npm start`)
  에서는 `build/`가 프로젝트 폴더에 실제로 있어서 이 버그가 재현되지 않았던 것도 원인 파악을 늦춘 요인.
  (처음엔 "256px 프레임을 그대로 써서 안 보인다"고 잘못 진단하고 `.resize({width:16,height:16})`만
  적용했었는데, 그건 진짜 원인이 아니었음 — 파일 자체가 없었으니 리사이즈해도 여전히 빈 이미지였음.)
- **해결**: `build/icon.ico`와 트레이 전용 `build/tray-icon.png`를 `package.json`의 `extraResources`에
  추가해서 실제로 패키징되게 하고, `getPackagedAsset(filename, devSubdir)` 헬퍼로 packaged/dev 경로를
  일관되게 처리 (§6의 업데이트 토큰/인트로 영상과 동일한 패턴). **런타임에 `fs`나 `nativeImage`로 읽는
  파일은 전부 이 헬퍼를 거치거나 `extraResources`에 등록되어 있는지 확인할 것** — 새 애셋을 추가할 때
  가장 흔하게 반복될 만한 실수.
- 트레이 아이콘은 `build/icon.ico`(멀티 사이즈)를 런타임에 리사이즈하지 않고, 미리 32×32로 렌더링해둔
  `build/tray-icon.png`를 그대로 사용 — 멀티 프레임 `.ico`에서 프레임을 골라 리사이즈하는 것보다 훨씬
  예측 가능함.

### 4.12 UI 레이아웃 재설계 — "정석안"(1a) + 설정만 분리하는 레일(1b) + Nocturne 디자인 토큰
UI 목업(Claude Design 캔버스, `Ullim app UI mockups/` 폴더 — 특히 `_ds/nocturne-*/styles.css`가
실제 디자인 시스템 소스)을 검토하고 처음엔 "레일 + 4개 탭(목록/재생/EQ/설정)"으로 전부 분리했었는데,
사용자 피드백("한 화면에 다 있고 여유 있는 밀도였으면 좋겠다")을 받고 최종적으로는 **목업의 1a
안(좌: 재생목록 / 우: 스테이지+EQ, 전부 한 화면)을 기본 레이아웃으로 유지하면서, 레일은 "설정" 화면
하나만 분리해서 꺼내는 용도로만 쓰는** 형태로 정리했다.

- **구조**: `.app` = `.rail`(좌측 아이콘 60px) + `.pages`(나머지 전체). `.pages` 안에 `#pageMain`(기본,
  1a 그대로: 사이드바 재생목록 + 스테이지/파형 + 탐색바 + 재생 컨트롤 + EQ 패널이 전부 한 화면)과
  `#pageSettings`(§4.5의 토글 4개 + 버전/업데이트 확인) 두 개만 존재. 레일 버튼은 `data-page` 속성이
  있는 것만 페이지 전환 대상이고(홈/설정), 오버레이 핀 버튼은 `data-page`가 없어서 전환 로직에서
  자동으로 제외됨.
- **페이지 전환은 클래스로, `hidden` 속성은 쓰지 않음**: `.page { display:none } .page.active
  { display:flex }` 처럼 클래스 기반으로 전환한다. 첫 시도 때는 `hidden` 속성 + `.tab-view{display:flex}`
  조합을 썼다가 실제로 화면에 4개가 전부 겹쳐 보이는 버그가 났었다 — **원인은 `[hidden]{display:none}`이
  브라우저 기본(user-agent) 스타일시트 규칙이라, author 스타일시트의 `.tab-view{display:flex}`가
  명시도(specificity)와 무관하게 항상 그것보다 우선 적용되기 때문**이었다. 클래스 기반 토글은 이 origin
  우선순위 문제 자체가 없어서 재발 위험이 없다.
- **Nocturne 디자인 토큰**: `src/renderer/style.css`와 `src/overlay/overlay.css` 양쪽 다 `:root`에
  같은 토큰을 하드코딩해서 갖고 있음 (두 창은 별도 문서라 CSS 커스텀 프로퍼티를 공유할 수 없음) —
  `--color-bg:#161826`, `--color-surface:#232532`, `--color-text:#e9e9ed`, `--color-accent:#9184d9`
  등. 구글 폰트(Inter)는 이 앱의 CSP(`style-src 'self' 'unsafe-inline'`, 외부 origin 예외 없음)로는
  로드할 수 없어서 `"Inter", "Segoe UI", ...` 폴백 스택으로 근사함. 버튼도 목업의 `.btn`/`.btn-primary`
  등 컴포넌트 클래스를 그대로 이식 — 꽉 찬 배경색 버튼이 아니라 테두리만 있다가 hover 시 액센트 컬러가
  옅게 깔리는 outline 스타일.
- **아이콘은 이모지가 아니라 인라인 SVG**: 재생/일시정지/이전/다음/셔플/반복/볼륨/홈/설정/핀/닫기 전부
  얇은 선(stroke) 또는 단색 채움 SVG로 통일 (main.js가 아니라 각 window의 index.html/renderer.js에
  하드코딩된 마크업 — 아이콘 폰트 CDN은 CSP상 불러올 수 없어서 직접 그림). 재생/일시정지처럼 상태에 따라
  바뀌는 아이콘은 `PLAY_ICON`/`PAUSE_ICON` 문자열을 버튼의 `innerHTML`에 갈아끼우는 방식
  (`setPlayIcon()` in renderer.js, 오버레이는 overlay.js에 동일 패턴 복붙).
- **CSS 주석 안에 `*/` 를 절대 넣지 말 것 (실제로 겪은 버그)**: `style.css` 맨 위 설명 주석에 목업 파일
  경로(`nocturne-*/styles.css`)를 그대로 적었다가, 그 안의 `*/`가 주석을 조기 종료시켜 `:root{...}`
  색상 변수 블록 전체가 파서에 의해 통째로 버려지는 사고가 있었다. 결과: 텍스트는 전부 브라우저 기본값인
  검은색으로, 배경만 `BrowserWindow`의 네이티브 `backgroundColor` 옵션(CSS와 무관) 때문에 어두운 색으로
  남아 "글씨가 안 보인다"는 증상으로 나타났다. `document.styleSheets[0].cssRules`에서 `:root` 규칙이
  통째로 빠져 있는지 확인하면 이 클래스의 버그를 바로 잡아낼 수 있다. 재현 시 CSS 파일 안에 아무 텍스트나
  자유롭게 쓰지 말고, 특히 파일 경로/글롭 패턴처럼 `*`와 `/`가 인접할 수 있는 문구는 주석에서 피할 것.
- **EQ 슬라이더 — 여러 번 갈아엎은 끝에 "그냥 진짜 `<input>`을 돌려서 쓰기"로 정착함**:
  1. 처음엔 `-webkit-appearance: slider-vertical` — 네이티브 동그란 손잡이가 커스텀 손잡이 아래에
     겹쳐 보이는 버그.
  2. `writing-mode: vertical-lr` + `accent-color`(네이티브 테마 위임)로 교체 — 오버레이의 짧은 트랙에서
     네이티브 손잡이가 과하게 커 보이는 문제, 반투명 오버레이 창이 다른 배경(흰 화면 등) 위에 떠 있을
     때 트랙 자체가 잘 안 보이는 문제.
  3. 진짜 `<input>`은 `opacity:0`으로 완전히 투명하게 만들어 드래그만 담당시키고, 그 위에 트랙/채움
     막대/원형 손잡이를 손으로 그린 `<div>` 3개를 겹쳐 그리는 방식으로 교체 — 시각적으로는 의도대로
     나왔지만 **실제 마우스 드래그로 조작이 전혀 안 되는 회귀**가 발생함 (`writing-mode` +
     `-webkit-appearance:none` + `opacity:0` 조합에서 이 Chromium 빌드가 포인터 위치를 값으로 제대로
     추적하지 못한 것으로 보임 — 정확한 원인은 특정하지 못했음, 재현 시 이 조합을 피할 것).
  4. **최종**: 손으로 그리는 방식을 전부 걷어내고, 리버브/볼륨/탐색바와 완전히 동일한 방식의 진짜
     `<input type="range">`를 그냥 `transform: rotate(-90deg)`로 시각적으로만 90도 돌려서 씀
     (`.eq-slider-wrap input[type="range"]`, main/오버레이 동일 — `position:absolute; top:50%;
     left:50%; transform: translate(-50%,-50%) rotate(-90deg);`). 손잡이 모양·트랙 채움(`--fill`
     그라데이션)까지 전부 공용 `input[type="range"]` 규칙을 그대로 물려받으므로 커스텀 CSS가 필요 없고,
     `updateRangeFill()`(seek/volume/reverb와 공유) 한 함수로 전부 갱신된다. 브라우저는 CSS
     `transform`으로 회전된 엘리먼트에 대해서도 마우스 드래그 위치를 정확히 히트테스트하므로(내부적으로
     여전히 평범한 가로 슬라이더이고 화면에 그려지는 방식만 다름) 이 조합에서는 드래그가 문제없이
     동작한다 — **세로 슬라이더가 필요하면 `writing-mode`나 `slider-vertical`보다 이 `transform` 방식을
     먼저 시도할 것.** 오버레이의 미니 EQ는 패널 크기에 따라 트랙 길이가 유동적이라, 회전 전 `width`
     (=회전 후 세로 길이)를 CSS만으로 부모 높이에 맞출 수 없어서 `syncMiniSliderSizes()`
     (`overlay.js`)가 렌더링된 wrap의 `clientHeight`를 읽어 각 입력의 `width`에 픽셀 값으로 반영한다
     (패널이 펼쳐지거나 창 크기가 바뀔 때마다 재호출).
  - **CDP로 이 버그를 못 잡았던 이유**: 자동화 테스트에서 슬라이더 값 변경을 `input.value = x;
    input.dispatchEvent(new Event('input'))`로 검증했는데, 이 방식은 값 변경 로직(JS 이벤트 리스너)만
    검증할 뿐 실제 마우스 드래그 시 브라우저가 포인터 위치를 값으로 변환하는 네이티브 로직은 전혀
    타지 않는다 — 그래서 "코드상 정상 동작"처럼 보였지만 실제 드래그는 안 되는 상태로 릴리스 직전까지
    남아있었다. 이 환경에서는 `Input.dispatchMouseEvent`(진짜 OS 레벨 입력 합성)도 응답 없이 멈춰서
    자동으로 검증할 수 없었음 — 이런 종류의 "실제 포인터 드래그가 되는지"는 결국 사람이 직접 확인해야
    했다.
- **CDP 자동화 테스트 시 주의**:
  - `Runtime.evaluate`의 `expression`은 페이지의 실제 전역 스코프에서 평가되므로, 서로 다른 `evaluate`
    호출에서 같은 이름으로 `const`/`let`을 반복 선언하면 "Identifier has already been declared" 에러가
    난다 — 매번 `(function(){ ... })()`로 감싸서 로컬 스코프를 만들 것.
  - 렌더러가 `window.api.saveSettings(...)`를 외부에서 직접 호출해 설정 파일에 트랙을 주입해도, 그 후
    `Page.reload`를 하면 `beforeunload` 핸들러가 (여전히 비어 있는) 실제 렌더러 상태로 파일을 덮어써
    버린다 — 이 경로로 테스트하려면 `Page.reload` 대신 프로세스를 완전히 종료/재시작해야 한다.
  - `element.hidden`(IDL 속성)이 올바르게 토글되는지만 확인하는 건 충분하지 않다 — 위의 `[hidden]`
    무력화 버그처럼, 속성은 맞게 바뀌어도 실제 화면에 그려지는 값(`getComputedStyle(el).display`)은
    다를 수 있다. 레이아웃/가시성 버그를 검증할 땐 반드시 computed style을 직접 확인할 것.

## 5. 프로세스 간 통신(IPC) 채널 요약

| 채널 | 방향 | 용도 |
|---|---|---|
| `open-files-dialog` | renderer→main (invoke) | 파일 선택 다이얼로그 |
| `toggle-overlay` | renderer→main (invoke) | 오버레이 창 열기/닫기, 열림 여부 반환 |
| `overlay-command` | overlay→main→renderer | 오버레이 버튼 클릭(재생/이전/다음/볼륨/탐색)을 메인 창에 전달 |
| `overlay-close` | overlay→main | 오버레이 닫기 |
| `player-state-update` | renderer→main→overlay | 재생 상태(제목/재생여부/볼륨/진행률/EQ 등) 오버레이에 반영 |
| `player-level-update` | renderer→main→overlay | 오디오 레벨(0~1, 100ms 간격) — 오버레이 dot 박동용, 가벼운 채널 |
| `overlay-closed` | main→renderer | 오버레이가 닫혔음을 메인 창 UI(핀 버튼)에 반영 |
| `remote-command` | main→renderer | 오버레이 또는 트레이 메뉴에서 온 커맨드 실행 |
| `get-app-version` / `check-for-update` / `download-update` / `install-update` | renderer→main (invoke) | 자동 업데이트 |
| `update-status` | main→renderer | 업데이트 진행 상태 이벤트 |
| `load-settings` / `save-settings` | renderer↔main | 설정 파일 읽기/쓰기 |
| `get-intro-video-url` | splash→main (invoke) | 인트로 영상의 `file://` URL 조회 |
| `splash-done` | splash→main | 인트로 영상 종료/건너뛰기 → 스플래시 창 닫고 메인 창 표시 |

## 6. 배포 절차 (재현용 명령어)

```bash
# 1. 의존성 설치
npm install

# 2. 개발 실행
npm start

# 3. 빌드 (installer exe 생성, dist/ 폴더)
npm run dist

# 4. 배포 (GitHub Releases 업로드까지, GH_TOKEN 필요)
npm run publish
```

**주의 — 애셋 파일명 함정**: `electron-builder`가 만드는 `dist/latest.yml`은 파일명의 공백을
**대시(-)**로 치환한 이름(`Ullim-Setup-1.0.0.exe`)을 기대한다. 만약 `npm run publish`
(electron-builder 자체 업로더) 대신 `gh release upload`로 **원본 파일명(공백 포함)**을 그대로 올리면,
GitHub이 공백을 **점(.)**으로 치환해버려서 이름이 서로 안 맞아 앱의 자동 업데이트가
`Cannot find asset "Ullim-Setup-x.x.x.exe"` 오류로 실패한다. `gh`로 수동 업로드할 때는 반드시
로컬에서 파일명을 대시 버전으로 복사한 뒤 그 이름으로 올릴 것.

```bash
cp "dist/Ullim Setup 1.0.x.exe" "dist/Ullim-Setup-1.0.x.exe"
cp "dist/Ullim Setup 1.0.x.exe.blockmap" "dist/Ullim-Setup-1.0.x.exe.blockmap"
gh release create vX.X.X --repo <owner>/<repo> --draft \
  "dist/Ullim-Setup-1.0.x.exe" \
  "dist/Ullim-Setup-1.0.x.exe.blockmap" \
  "dist/latest.yml"
# 그 다음 GitHub 웹에서 draft를 "Publish release"로 공개해야 electron-updater가 찾아냄 (draft는 안 보임)
```

**주의 — `signAndEditExecutable: false`와 아이콘**: 이 PC의 Windows 보안 정책 때문에
`package.json`의 `build.win.signAndEditExecutable`을 `false`로 꺼뒀는데(§7 참고), 이 옵션은
**exe에 아이콘을 심는 rcedit 단계까지 같이 꺼버린다**. 그래서 `npm run dist`만 실행하면 `build.win.icon`을
지정해도 실제 exe에는 기본 Electron 아이콘이 박힌다. 아이콘을 실제로 반영하려면 빌드 후 수동으로
rcedit를 한 번 더 돌려야 한다:

```bash
# 1. 평소처럼 빌드 (아이콘은 아직 안 박힌 상태)
npm run dist

# 2. rcedit로 언팩된 exe에 아이콘 수동 삽입
#    rcedit 바이너리는 winCodeSign 캐시 폴더 아무 데나 있음 (부분 다운로드라도 rcedit 자체는 받아짐):
#    C:\Users\<user>\AppData\Local\electron-builder\Cache\winCodeSign\<hash>\rcedit-x64.exe
"<rcedit-x64.exe 경로>" "dist\win-unpacked\Ullim.exe" --set-icon "build\icon.ico"

# 3. 아이콘이 박힌 win-unpacked를 그대로 다시 NSIS로 포장 (재패키징 없이)
npx electron-builder --prepackaged "dist\win-unpacked" --win nsis
```
`--prepackaged`는 electron-builder가 처음부터 다시 패키징하지 않고, 이미 있는 `win-unpacked` 폴더를
그대로 설치파일로 감싸기만 하므로 방금 rcedit로 심은 아이콘이 유지된다. NSIS 설치파일(`Setup.exe`)
자체의 아이콘은 `signAndEditExecutable`과 무관하게 `build.win.icon` 설정만으로 정상 반영된다 —
문제는 오직 앱 내부의 실행 파일(`Ullim.exe`)에만 있다.

## 7. 이 PC에서 겪었던 환경 이슈 (재현 시 참고)

- **Windows 애플리케이션 제어 정책**: 이 PC는 서명되지 않은 새 실행파일 실행을 막는 보안 정책이 걸려
  있어서, `electron-builder`가 언인스톨러를 생성하려고 방금 빌드한 exe를 스스로 실행하는 단계에서
  `spawn UNKNOWN` 오류가 난 적이 있음 (정책이 풀리거나 예외 처리되면 재현 안 될 수 있음).
- **Git Bash에서 `spawn UNKNOWN`**: 일부 자식 프로세스 실행은 PowerShell에서는 되고 Git Bash(POSIX
  sh)에서는 실패하는 경우가 있었음 — 안 될 때 다른 셸로 재시도해볼 것.
- **`.env`/토큰류를 다루는 셸 명령은 자동화 차단기(classifier)에 걸릴 수 있음** — 이런 경우
  `gh` CLI가 이미 로그인되어 있으면 `gh` 명령 자체(토큰을 별도로 읽어 echo/redirect하지 않고 `gh`가
  내부적으로 처리하는 것)는 대체로 통과함. 토큰 값을 직접 다루는 명령(`echo $TOKEN`,
  `$env:GH_TOKEN = ...`)은 막힐 수 있으므로 피할 것.
- **Draft 릴리스 공개(Publish release)는 자동화가 막힘** — 사람이 GitHub 웹에서 직접 눌러야 함.

## 8. 향후 아이디어 (아직 미구현, 논의됨)

- ID3 태그 읽기(제목/아티스트/앨범아트 표시) — `music-metadata` 같은 패키지 필요
- 폴더 통째로 추가 (재귀적으로 오디오 파일 스캔)
- 미디어 키(키보드/이어폰 재생 버튼) 지원 — Electron `globalShortcut` 또는 `MediaSession` API
- Windows 작업표시줄 썸네일 툴바 버튼 (`BrowserWindow.setThumbarButtons`)
- 리버브 wet 게인을 % 옆에 dB로도 보조 표시 (사용자 의견 교환만 하고 미적용 상태)
- `build/icon.ico`는 현재 32×32 한 사이즈만 포함되어 있음 — 외주로 아이콘을 새로 받을 땐
  16/32/48/256px을 전부 포함한 멀티 레졸루션 ico로 요청할 것 (큰 사이즈에서 흐려지는 것 방지)

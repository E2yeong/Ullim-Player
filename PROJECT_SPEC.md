# Ullim — 재현/재구축 명세서

> 앱 이름은 **Ullim**(울림)이지만, GitHub 저장소는 처음 만들었을 때 이름 그대로
> `E2yeong/music-player-pro`를 계속 쓰고 있다 (저장소 이름 변경은 별도로 하지 않음).
> `package.json`의 `name`/`productName`은 `ullim`/`Ullim`, `appId`는 `com.local.ullim`.

이 문서는 이 프로젝트를 처음부터 다시 만들어야 할 때(다른 PC, 다른 이름, 다른 저장소 등) 참고할 수 있도록
기능·아키텍처·설정 방법을 정리한 문서입니다. 코드를 직접 읽지 않아도 이 문서만 보고 동일한 앱을
재구성할 수 있는 것을 목표로 합니다.

## 1. 한 줄 요약

로컬 mp3/mp4 파일을 재생하는 Windows 데스크톱 앱(Electron). 플레이리스트, 반복/셔플, 8밴드 그래픽 EQ,
리버브, 항상 위에 뜨는 미니 플레이어(오버레이), 시스템 트레이 백그라운드 재생, 설정 자동 저장/복원,
GitHub Releases 기반 자동 업데이트를 갖춤.

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
      index.html
      style.css
      renderer.js          # 메인 창 전체 로직 (재생, 플레이리스트, EQ, 설정 저장/복원, 업데이트 UI)
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
- 창의 X(닫기) 버튼을 누르면 **종료가 아니라 숨김**(`e.preventDefault(); mainWindow.hide()`).
- 실제 종료는 트레이 메뉴의 "종료"(`app.isQuitting = true; app.quit()`)나 `before-quit` 이벤트를 통해서만.
- 트레이 메뉴: 열기 / 재생·일시정지 / 다음 곡 / 이전 곡 / 종료. 트레이 아이콘 클릭 시 창 show/focus.
- 창이 숨겨져 있어도 렌더러 프로세스는 계속 살아있으므로 재생은 백그라운드에서 계속되고, 오버레이로
  계속 제어 가능.

### 4.5 설정 자동 저장/복원
- 저장 위치: `app.getPath('userData')/player-settings.json` (Windows: `%APPDATA%\<productName 소문자>\`)
- 저장 항목: `tracks`(경로+이름 배열), `currentIndex`, `repeatMode`, `shuffle`, `eqEnabled`, `volume`,
  `eq: { bands: number[8], reverb: number }`, `overlayBounds`.
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

### 4.7 실행 시 인트로 영상
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

## 5. 프로세스 간 통신(IPC) 채널 요약

| 채널 | 방향 | 용도 |
|---|---|---|
| `open-files-dialog` | renderer→main (invoke) | 파일 선택 다이얼로그 |
| `toggle-overlay` | renderer→main (invoke) | 오버레이 창 열기/닫기, 열림 여부 반환 |
| `overlay-command` | overlay→main→renderer | 오버레이 버튼 클릭(재생/이전/다음/볼륨/탐색)을 메인 창에 전달 |
| `overlay-close` | overlay→main | 오버레이 닫기 |
| `player-state-update` | renderer→main→overlay | 재생 상태(제목/재생여부/볼륨/진행률 등) 오버레이에 반영 |
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

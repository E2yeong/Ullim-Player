# Music Player Pro

로컬 mp3 / mp4 파일을 재생하는 데스크톱 음악 플레이어입니다 (Electron).

> 아키텍처, IPC 구조, 자동 업데이트 설정 방법 등 자세한 내용은 [PROJECT_SPEC.md](PROJECT_SPEC.md)를 참고하세요.
> 이 프로젝트를 나중에 다시 만들어야 할 때를 위한 재현 명세서입니다.

## 기능
- mp3, mp4, wav, ogg, m4a, flac, webm 파일 재생 (버튼으로 추가 또는 드래그 앤 드롭)
- 플레이리스트 관리 (추가 / 삭제 / 전체 삭제 / 클릭 재생)
- 이전 곡 / 다음 곡 / 반복재생(끄기·전체·한 곡) / 셔플
- 탐색 바(구간 이동), 볼륨 조절
- 8밴드 그래픽 이퀄라이저 (60/150/400/1K/2.5K/6K/12K/16K, ±36dB) + Reverb(0~100%)
- 프리셋: Flat, Bass Boost, Vocal, Hall Reverb
- 항상 위에 떠 있는 미니 플레이어(오버레이) — 크기 조절 가능, 진행바 포함
- 시스템 트레이 최소화 (닫아도 백그라운드에서 재생 계속)
- 설정(플레이리스트/EQ/볼륨/반복·셔플) 자동 저장 및 복원
- GitHub Releases 기반 자동 업데이트

## 실행 (개발 모드)
```bash
npm install
npm start
```

## 설치용 exe 빌드
```bash
npm run dist
```
빌드가 끝나면 `dist` 폴더에 설치 파일(.exe, NSIS)이 생성됩니다.

## 배포 (자동 업데이트용 GitHub Release)
```bash
npm run publish
```
자세한 배포 절차와 주의사항은 [PROJECT_SPEC.md](PROJECT_SPEC.md#6-배포-절차-재현용-명령어)를 참고하세요.

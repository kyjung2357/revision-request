# Marketplace 수동 배포 안내

이 저장소의 빌드와 패키징 명령은 로컬 VSIX 파일을 만듭니다. 실제 공개는 아래 관리 페이지에서 배포자가 직접 수행합니다.

## Publisher와 버전 확인

현재 `package.json`은 다음 식별자를 사용합니다.

| 항목 | 값 |
| --- | --- |
| Publisher ID | `kyjung2357` |
| Extension name | `revision-request` |
| 현재 버전 | `0.1.0` |
| 확장 ID | `kyjung2357.revision-request` |

[Marketplace publisher 관리 페이지](https://marketplace.visualstudio.com/manage/publishers/)에 로그인해서 **본인 계정에 `kyjung2357` publisher의 게시 권한이 있는지** 먼저 확인합니다. GitHub 사용자 이름이 같다는 사실만으로 Marketplace 권한이 생기지는 않습니다. 실제 사용할 publisher가 다르면 `package.json`의 `publisher`를 그 ID로 바꾸고 다시 패키징합니다. Publisher 생성과 VSIX 수동 업로드는 [Microsoft 공식 배포 안내](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-an-extension)를 참고합니다.

기존에 올린 확장을 갱신할 때에는 게시된 버전보다 높은 새 버전을 사용하고, 생성된 VSIX의 버전도 확인합니다.

README의 상대 링크는 패키징 시 저장소 URL을 기준으로 변환됩니다. 공개 저장소 `https://github.com/kyjung2357/revision-request`에 README, `docs/`, `LICENSE` 등 링크 대상 파일이 실제로 게시되어 있어야 합니다. 사용자가 배포할 소스를 해당 공개 저장소에 push한 뒤, 패키징에 사용한 branch에서 링크가 열리는지 확인합니다. Git push와 Marketplace 업로드는 로컬 패키지 생성과 별개의 작업입니다. [상대 링크 처리 공식 안내](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#marketplace-integration)

## 로컬 빌드와 검증

저장소 폴더에서 Node.js와 npm으로 실행합니다. 확장 사용자의 MCP 연결에는 별도 Node 설치가 필요하지 않지만, 저장소를 빌드하는 개발 환경에는 필요합니다.

```sh
npm ci
npm run package
```

`npm ci`는 lockfile에 기록된 의존성을 설치합니다. `npm run package`는 타입 검사와 빌드, 외부 라이브러리 고지 생성을 거쳐 현재 manifest 이름·버전의 VSIX를 만듭니다. 빌드만 실행하려면 `npm run build`를 사용합니다.

배포 전 검증은 다음 명령으로 실행할 수 있습니다.

```sh
npm test
npm run test:mcp
npm run test:extension
npm run test:ui
```

`test:mcp`는 로컬 bridge와 실제 stdio 프로토콜을 검증하고, `test:extension`은 VS Code Extension Development Host 검증을 실행합니다. `test:ui`는 설치된 Edge 또는 Chrome을 사용합니다. 검증 뒤 파일을 수정했다면 `npm run package`로 최종 파일을 다시 만듭니다.

현재 버전의 결과는 `.codex-artifacts/revision-request-0.1.0.vsix`입니다. 빌드·검증·패키지 결과는 Git에서 제외된 `.codex-*` 폴더에 보관합니다.

현재 확인한 실행 환경은 **Windows / VS Code 1.145.3**입니다. macOS, Linux와 manifest의 최소 버전 `1.96`에서는 검증하지 않았습니다. 이 문서의 호환성 표기는 그 환경에서의 테스트를 의미하지 않습니다.

## 배포 파일과 라이선스

프로젝트 자체는 [MIT License](../LICENSE)를 사용합니다. MIT는 고지를 유지하는 조건으로 상업적 재사용도 허용합니다. 번들에 포함된 외부 라이브러리에는 각 라이브러리의 라이선스가 계속 적용됩니다.

빌드 시 `.codex-build/THIRD_PARTY_NOTICES.txt`가 생성되며, VSIX에는 프로젝트 `LICENSE`와 이 외부 라이브러리 고지가 함께 포함됩니다. 고지 파일을 생성하지 못하거나 패키지에서 빠졌으면 해당 파일을 포함하도록 빌드·패키징을 고친 뒤 배포합니다.

VS Code의 **Extensions → Install from VSIX...**로 최종 파일을 설치하고, 별도 테스트 폴더의 기존 UTF-8 파일과 `.rr` 요청으로 미리보기·Accept·Ignore를 확인할 수 있습니다. 저장소의 `examples/`와 CLI 스크립트는 VSIX에 들어 있지 않습니다. 설치 사용자는 [README 시작 안내](../README.md#start-with-your-own-files)와 [MCP 안내](MCP.md)를 사용합니다.

## 직접 업로드

1. [Marketplace publisher 관리 페이지](https://marketplace.visualstudio.com/manage/publishers/)에 로그인하고 게시 권한이 있는 publisher를 선택합니다.
2. 신규 확장은 Visual Studio Code 확장 추가 작업을 선택합니다. 기존 확장은 해당 확장의 새 버전 업로드 작업을 선택합니다.
3. 방금 만든 `.vsix`를 업로드하고 확장 이름, publisher, 버전, README와 라이선스 표시를 확인합니다.
4. Marketplace 검증과 게시 결과를 관리 페이지에서 확인합니다. 로컬 패키징 성공만으로 공개가 완료된 것은 아닙니다.

이 절차는 [공식 문서의 수동 VSIX 업로드 방식](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-an-extension)을 사용합니다. 저장소의 일반 빌드·테스트·패키징 명령에는 업로드 단계가 없습니다.

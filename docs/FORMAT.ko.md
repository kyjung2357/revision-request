# .rr JSON 형식 — 버전 1

`.rr`는 원본과 수정 제안의 전체 텍스트를 담는 UTF-8 JSON 파일입니다. 파일을 만들거나 미리보기를 여는 것만으로 원본이 바뀌지 않습니다. 사용자가 **Accept**한 변경만 원본에 반영됩니다.

LaTeX 전용 형식이 아닙니다. 이미 존재하는 UTF-8 텍스트 파일이면 `.py`, `.ts`, `.md`, `.json`, `.tex` 등에 같은 방식으로 사용할 수 있습니다. [English reference](FORMAT.md), [JSON schema](../schemas/revision-request.schema.json), [MCP 연결 안내](MCP.md)도 참고할 수 있습니다.

## 파일 이름과 대상

요청 하나는 원본 파일 하나만 다룹니다. 원본의 **파일 이름과 기존 확장자를 모두 유지한 뒤 `.rr`를 붙입니다.**

| 원본 | 요청 파일 이름 |
| --- | --- |
| `math.py` | `math.py.rr` |
| `index.ts` | `index.ts.rr` |
| `README.md` | `README.md.rr` |
| `settings.json` | `settings.json.rr` |
| `manuscript.tex` | `manuscript.tex.rr` |

`files`는 배열이지만 원소는 정확히 하나입니다. 요청 파일은 원본 옆이나 같은 workspace 안의 다른 폴더에 둘 수 있습니다. 어느 경우든 파일 이름 규칙은 같습니다.

원본 대상은 이미 존재하는 일반 UTF-8 텍스트 파일이어야 합니다. 바이너리, 새 원본 파일 생성, 원본 삭제와 이름 변경은 지원하지 않습니다. `after`가 빈 문자열이면 파일 내용만 비우며, 파일 자체는 남습니다.

## 전체 예제: Python 수정

원본이 `src/math.py`이면 아래 JSON을 `math.py.rr`라는 이름으로 저장합니다. 이 예제의 원본은 마지막 줄 뒤에 LF 개행이 있습니다.

```json
{
  "version": 1,
  "title": "제곱 계산 수정",
  "files": [
    {
      "path": "src/math.py",
      "before": "def square(x):\n    return x + x\n",
      "after": "def square(x):\n    return x * x\n",
      "reason": "입력값의 제곱을 계산하도록 곱셈을 사용합니다.",
      "explanations": [
        { "line": 2, "text": "이 줄의 덧셈을 곱셈으로 바꿉니다." }
      ]
    }
  ]
}
```

위 예제를 다른 파일에 적용할 때에는 반드시 그 파일의 실제 현재 내용으로 `before`를 바꿔야 합니다. 예제의 원본을 그대로 사용한다고 가정하면 안 됩니다.

## 필드

| 필드 | 필수 | 의미 |
| --- | --- | --- |
| `version` | 예 | 숫자 `1`. |
| `title` | 예 | 공백만으로 이루어지지 않은 요청 제목 metadata. 현재 미리보기 배너에는 표시하지 않습니다. |
| `description` | 아니요 | 선택적인 요청 metadata. 배너나 개별 Why의 기본 설명으로 표시하지 않습니다. |
| `files` | 예 | 대상 하나를 담는 배열. |

`files[0]`의 필드는 다음과 같습니다.

| 필드 | 필수 | 의미 |
| --- | --- | --- |
| `path` | 예 | `.rr`를 포함하는 VS Code workspace 폴더 기준의 상대 경로. `/` 사용. |
| `before` | 예 | 수정 전 원본 전체 텍스트의 정확한 snapshot. |
| `after` | 예 | 수정 제안 전체 텍스트. 변경한 줄만 넣는 형식이 아닙니다. |
| `reason` | 아니요 | 각 변경 블록의 기본 Why 설명. |
| `explanations` | 아니요 | 특정 변경 블록의 Why 설명을 덮어쓰는 `{ "line": 숫자, "text": 문자열 }` 배열. |

직접 작성하는 JSON에는 `title`이 필수입니다. MCP의 `rr_create_request`에서 `title`을 생략하면 서버가 이 필수 metadata를 채웁니다. 두 경우 모두 미리보기에서 제목을 별도로 표시하지 않습니다.

## 경로 기준

다음 workspace를 열었다고 가정합니다.

```text
project/
  src/math.py
  proposals/math.py.rr
```

요청의 `path`는 `"src/math.py"`입니다. `.rr`가 있는 `proposals/`를 기준으로 `../src/math.py`를 쓰면 안 됩니다. Multi-root workspace에서는 요청을 포함하는 workspace 폴더가 기준입니다.

절대 경로, 빈 경로 구간, `.`과 `..` 구간, `:`, 역슬래시, Windows 예약 장치 이름, 끝의 점·공백, workspace 밖으로 나가는 실제 경로는 거부됩니다. 경로 구분자 `/`와 LaTeX 명령의 역슬래시는 서로 다른 용도입니다.

## JSON 문자열과 정확한 원본 보존

`before`는 원본을 읽은 그대로여야 합니다. 공백, 탭, LF/CRLF, BOM, 마지막 개행 유무를 바꾸지 않습니다. `after`도 의도한 변경 외에는 이 특성을 유지합니다.

| 실제 텍스트 | JSON 문자열 안의 표기 |
| --- | --- |
| LF 개행 | `\n` |
| CRLF 개행 | `\r\n` |
| 탭 | `\t` |
| 큰따옴표 `"` | `\"` |
| 역슬래시 `\` | `\\` |
| 파일 시작의 UTF-8 BOM | 문자열 맨 앞의 `\uFEFF`로 표현 가능. 원래 있을 때만 보존. |

예를 들어 JSON 소스 파일의 한 줄 `{"enabled":true}`를 snapshot 문자열에 넣으면 `"{\"enabled\":true}\n"`처럼 내부 큰따옴표를 escape합니다. 원본에 마지막 개행이 없으면 끝에 `\n`을 덧붙이지 않습니다.

LaTeX 명령도 JSON 안에서는 역슬래시를 두 번 씁니다. 다음은 `paper/equation.tex`에 대한 완전한 요청 예제입니다.

```json
{
  "version": 1,
  "title": "등식의 우변 수정",
  "files": [
    {
      "path": "paper/equation.tex",
      "before": "\\[\n  a=b.\n\\]\n",
      "after": "\\[\n  a=c.\n\\]\n",
      "reason": "우변의 기호만 수정합니다."
    }
  ]
}
```

JSON에는 주석과 trailing comma를 넣지 않습니다. 가능하면 문자열을 직접 이어 붙이는 대신 JSON serializer로 생성합니다. 변경 색상이나 취소선용 markup을 snapshot에 추가할 필요는 없습니다. 확장이 비교 표시를 계산합니다.

## 줄 삽입 예제

기존 `src/settings.ts`의 한 줄 뒤에 새 줄을 추가하는 예제입니다. 기존 원본을 보존하고, `after`에 전체 결과를 담습니다.

```json
{
  "version": 1,
  "title": "재시도 횟수 추가",
  "files": [
    {
      "path": "src/settings.ts",
      "before": "export const enabled = true;\n",
      "after": "export const enabled = true;\nexport const retries = 3;\n",
      "explanations": [
        { "line": 2, "text": "원본의 첫 줄 다음 위치에 재시도 횟수를 추가합니다." }
      ]
    }
  ]
}
```

새 줄이 추가되어도 원본의 줄 번호가 제안 쪽 줄 번호로 바뀌는 것은 아닙니다. `explanations[].line`은 항상 원본을 기준으로 합니다.

## Why 설명과 oldStart

확장은 연속된 변경을 블록(hunk)으로 계산합니다. `explanations[].line`은 해당 블록의 **첫 원본 줄 번호 `oldStart`와 정확히 같아야** 합니다. 번호는 1부터 시작합니다. 블록 중간의 변경 줄 번호나 `after`의 줄 번호를 쓰면 그 블록의 설명으로 연결되지 않습니다.

순수 삽입은 원본에서 삽입할 위치의 줄 번호를 씁니다. 위 예제처럼 원본 첫 줄 뒤에 추가하면 `line: 2`입니다. 앞쪽에서 다른 줄을 추가했더라도 설명 번호를 새 제안의 줄 번호에 맞춰 밀지 않습니다.

특정 `explanations` 항목이 있으면 그 `text`가 `reason`보다 우선합니다. `text`가 빈 문자열이나 공백뿐이면 그 블록의 Why를 명시적으로 끕니다. 일치하는 항목이 없으면 `reason`을 사용하고, 둘 다 설명이 없으면 Why는 비활성화됩니다. 일치하지 않는 줄의 항목은 사용되지 않습니다.

`line`은 중복되지 않는 양의 safe integer여야 합니다. 최대값은 9,007,199,254,740,991입니다. `explanations`는 최대 10,000개이며, 각 `text`는 UTF-8 기준 50,000바이트 이하이고 NUL을 포함할 수 없습니다.

## 검토 결과와 Undo

- **Accept:** 해당 블록만 원본에 반영합니다.
- **Ignore:** 결정을 기록하고 원본을 바꾸지 않습니다.
- **Undo:** 결정한 블록을 다시 pending으로 돌립니다. Accepted를 Undo하면 해당 블록의 수정만 되돌리고, Ignored를 Undo하면 결정만 바꿉니다.

현재 원본이 예상 snapshot과 다르거나 저장하지 않은 수정이 있으면 Accept와 Accepted-block Undo를 차단합니다. 사용자나 다른 도구의 수정을 조용히 덮어쓰지 않습니다. 결정 상태는 VS Code workspace에 저장되며 JSON의 `files` 안에 쓰지 않습니다.

기본값 `revisionRequest.autoDeleteCompleted: true`에서는 마지막 Accept 또는 Ignore 뒤에 `.rr`를 삭제하고 미리보기를 닫습니다. 가능한 환경에서는 시스템 휴지통을 사용합니다. 검토 완료 후에도 Undo를 사용하려면 마지막 결정 전에 이 설정을 `false`로 바꾸어 요청을 유지해야 합니다. 확장 자체의 Undo와 native editor Undo는 별개이며, native editor Undo는 보장되지 않습니다.

## MCP로 만드는 경우

MCP 파일 도구는 신뢰한 로컬 workspace에서 사용하며, 저장하지 않은 원본 수정이 있으면 읽기와 제안을 거부합니다. `rr_read_target(path)`로 저장된 정확한 `content`와 SHA-256 `hash`를 읽고, `rr_create_request`에 `path`, `expectedHash`, 전체 `after`, `clientRequestId`를 전달합니다. 서버가 정확한 `before`를 읽어 채우고 hash가 여전히 일치하는지 검증합니다. 원본 바로 옆에 `<원본 경로>.rr`를 만들며 원본은 그대로입니다.

같은 `clientRequestId`와 같은 내용으로 재시도하면 같은 요청을 얻습니다. 이 재시도 정보도 용량이 제한된 로컬 registry에 기록이 남아 있는 동안 유지됩니다. 내용이 달라진 새 요청에는 새 ID를 사용합니다. 생성 도구는 사람의 결정을 기다리지 않고 pending 상태를 반환합니다. 이후 `rr_get_request_status`로 확인합니다. 자동 삭제 후에도 완료 receipt로 결과를 확인할 수 있습니다. 이 기록은 원본 전체 복사본이 아닌 로컬 metadata이며 최대 256개를 보관하므로 오래된 결과는 만료될 수 있습니다. `.rr`가 없다는 사실만으로 Accepted라고 판단하면 안 됩니다. Completed에도 Ignored 블록이 포함될 수 있으므로 개별 결정을 확인합니다.

`revisionRequest.mcp.allowAgentDecisions`는 기본 `false`입니다. 이때 MCP 에이전트에게 Accept·Ignore·Undo 도구가 제공되지 않고, 직접 호출도 거부됩니다. 사용자 수준에서 명시적으로 켜야 활성화되며 `.vscode/settings.json`으로는 켤 수 없습니다. 사용자의 UI 검토는 영향을 받지 않습니다. 이 설정이 에이전트의 별도 파일 접근이나 마우스 자동화까지 막는 것은 아닙니다.

MCP에서는 이 문서를 `rr://format/v1/ko`로 읽거나 `rr_get_format`에 `{"language":"ko"}`를 전달해 guide·schema·예제를 받을 수 있습니다. 형식 자료는 VS Code bridge가 없어도 제공됩니다. 자세한 연결 방법은 [MCP 안내](MCP.md)에 있습니다.

## 크기 제한

요청 JSON 전체는 UTF-8 기준 최대 20 MiB, `before`와 `after`는 각각 최대 5 MiB입니다. `title`은 2,000바이트, `description`, `reason`, 각 설명의 `text`는 50,000바이트 이하입니다. 길이는 글자 수가 아니라 UTF-8 바이트 수이며, NUL은 지원하지 않습니다.

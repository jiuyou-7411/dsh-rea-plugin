---
name: rea-tool-design
description: REA 工具的设计原则：为什么是 Evidence 而不是裸结果、覆盖与局限如何标注、什么该做成一个工具。扩展 REA 或理解其输出契约时阅读。
whenToUse: 编写或修改 REA 工具、理解 Evidence 契约
---
# REA tool design

Use the [tool-design guide](../../../docs/tool-design.md) for tool boundaries,
contract semantics, provider ownership, and discoverability. Inspect the current
contract and nearest existing tool relevant to the analyst question; source,
documentation, and live catalogs may describe different versions.

For a design request, return the proposed boundary, input/result shape, Evidence
semantics, nearest alternative, and verification approach. Implement when
requested, preserving the user's scope and existing authorization.

For implementation or verification, consult [testing](../../../docs/testing.md)
for the affected consumer and provider lanes, and
[contributing](../../../CONTRIBUTING.md) for generated-file ownership. Read
provider/workflow guides only as the task requires.
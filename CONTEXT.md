# Progress Interaction

This context is about how a human stays informed while an agent executes a long task. It exists because task definition and task execution are separate activities with separate owners: the human settles the work up front, then supervises it.

## Language

### Roles

**Supervision** (监督):
The human's role during execution — observing what the work is doing, and autonomously deciding whether to intervene.
_Avoid_: collaboration, interaction, human-in-the-loop, 交互, 协作

**Intervention** (介入):
Information or control supplied on the supervisor's own initiative during execution to improve, redirect, pause, or stop the work. It includes decisions, background, constraints, and corrections; it is not a routine approval gate.
_Avoid_: approval gate, feedback cycle, steering request, 审批门, 反馈循环, 请求纠偏

### Information

**Disclosure** (披露):
Model-authored information about a running execution that helps a supervisor decide whether to intervene. Disclosure is best-effort communication, not a runtime guarantee or a substitute for task state.
_Avoid_: report, progress update, narration, status, 汇报, 进度更新, 旁白

**Silence interval** (静默区间):
A span of execution in which the supervisor has seen no visible model text: it opens with a visible model message and closes when the next one arrives. Reminder cadence and the reminder budget are policy over this interval, so they reset with it rather than belonging to Disclosure itself.
_Avoid_: timeout, watchdog window, 超时, 看门狗

### Baseline

**Execution brief** (执行简报):
The settled goal, boundary, design, constraints, and verification method supplied by the caller so the model can execute autonomously. The disclosure policy assumes this brief exists; it does not discover or validate it.
_Avoid_: task contract, requirements bundle, 任务契约, 需求包

**Settled plan** (既定计划):
The task breakdown the human decided before execution began. It is the reference the supervisor measures execution against.
_Avoid_: todo, backlog, task list, 待办, 任务列表

**Settled constraints** (既定约束):
The design and policy decisions the human made before execution began. A departure from them is itself disclosable information.
_Avoid_: requirements, spec, prompt, 需求, 规范

### The excluded mode

**Negotiation** (协商):
Relocating a settled design or constraint decision back to the human during execution. Supervision replaces it: the model proceeds and discloses, and the human intervenes if the disclosure warrants it.
_Avoid_: question, clarification, confirmation, 提问, 澄清, 确认

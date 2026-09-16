# Constraint / instruction document discovery in an installed DSH tree

**Question.** What already discovers a repository's constraint/instruction documents (AGENTS.md and
similar), and can an out-of-tree plugin *ask the harness* for them instead of re-implementing
discovery?

**Tree audited.** `E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`
(packages named `dsh-*`). Host runtime service/event facts in §5 and §3 were read from the live
Cordis Inspect providers (`Service.listService`, `Event.listEvents`), not inferred from source.

**Installed versions** — every package cited below is `0.1.5-rc.2`, except `cordis@4.0.2`
(all read from each package's `package.json`). §7 lists them individually.

---

## 1. `dsh-agent-instructions` — what it discovers, how it reaches the model

`@deepseek-ai/dsh-agent-instructions@0.1.5-rc.2`.

### Discovery rule

| Aspect | Value | Cite |
|---|---|---|
| Discovery function | `discoverInstructionFiles(options, fileSystem)` | `dsh-agent-instructions/lib/index.js:552` |
| Public wrapper (exported) | `discoverBaselineInstructionFiles(options)` | `dsh-agent-instructions/lib/index.js:590`, exported at `:1311` |
| Project root markers | `['.git']` | `dsh-agent-instructions/lib/index.js:16` |
| Base candidates | `['AGENTS.md', 'CLAUDE.md']` | `dsh-agent-instructions/lib/index.js:17` |
| Local overlay candidates | `['AGENTS.local.md', 'CLAUDE.local.md']` | `dsh-agent-instructions/lib/index.js:18` |
| Max source bytes per file | `1048576` | `dsh-agent-instructions/lib/index.js:19` |
| User-global file | `$DSH_HOME/AGENTS.md` (hardcoded `AGENTS.md`) | `dsh-agent-instructions/lib/index.js:141`, `:561` |

- **Walks up parent directories — yes**, to find the *project root*: `findProjectRoot` climbs from
  `cwd` and returns the first directory containing a configured marker, else `resolve(cwd)` when the
  filesystem root is reached (`dsh-agent-instructions/lib/index.js:480-488`, fallback at `:485`).
- **Then walks down** the inclusive root-to-`cwd` chain: `ancestorChain(root, cwd)` returns
  broadest→most-specific (`dsh-agent-instructions/lib/index.js:495-508`), consumed at `:578`.
- **Multi-file and always multi-file — yes.** For every directory on that chain it reads *both*
  candidate lists, base first then local overlays:
  `for (const dir of ancestorChain(projectRoot, cwd)) for (const candidates of [config.instructionFileCandidates, config.localInstructionFileCandidates]) for (const file of await allExistingInstructionFiles(...)) addFile(file)`
  (`dsh-agent-instructions/lib/index.js:578`). It concatenates; it does **not** parse or merge
  sections of a file.
- **Precedence / merge.** Ordered user-global first, then root→cwd, within each directory
  `AGENTS.md`→`CLAUDE.md`→`AGENTS.local.md`→`CLAUDE.local.md`, with absolute-path dedup
  (`dsh-agent-instructions/lib/index.js:556-560`, `:578`). The rendered intro states the rule
  verbatim: "More specific instructions take precedence over broader ones."
  (`dsh-agent-instructions/lib/index.js:113`).
- **Per-directory content dedup.** Later candidates whose *trimmed* content SHA-1 matches an earlier
  sibling in the same directory are dropped; first candidate wins; different directories never
  collapse (`dsh-agent-instructions/lib/index.js:632-648`, digest helper at `:101-103`).
- **Nested discovery is touch-driven, not a watcher.** After a successful first-party `read`/`write`/
  `edit`, `descendantDirsBetween(root, touchedPath)` adds the newly crossed directories
  (`dsh-agent-instructions/lib/index.js:515-521`, used at `:939`; touch capture at `:1086-1097`,
  `:1289-1308`). Documented as a limitation in `dsh-agent-instructions/README.md:214-215`.
- **Byte budget.** `maxBytes` is required; `renderInstructionContext` drops whole broader files
  before truncating the most-specific one (`dsh-agent-instructions/lib/index.js:293-372`). Shipped
  rows set `maxBytes: 65536`
  (`dsh-base/cordis.patch.yml:268-271`, `dsh-agent-presets/presets/cordis/agent.cordis.yml:32-35`).
- The user-global `$DSH_HOME` scope has **no** `.local` overlay — candidate lists apply only to the
  project chain (`dsh-agent-instructions/lib/index.js:561-575` vs `:578`; `README.md:216`).

### How it reaches the model — durable user-role history messages, not a prompt section

- **Injection site: `agent/pre-step`.** `ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => { const decision = await next(); ... })`
  at `dsh-agent-instructions/lib/index.js:1270`; the composed message is spliced in *immediately
  after the last claimed message*: `const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired)` (`dsh-agent-instructions/lib/index.js:1283`).
- **It is a user message, not a system-prompt section.** Baseline/refresh messages are built with
  `createUserMessage(...)` (`dsh-agent-instructions/lib/index.js:766-777`, `:784-795`), source
  `{ kind: "agent-instructions", form: "instructions", changes }` (and `baseline: true` /
  `baselineIdentity` for the baseline, `:1169-1178`). The `<system-reminder>` framing is *plugin-owned
  text inside the message body* (`:111-116`, `:256-266`), not a harness prompt section.
- **Baseline** is composed at the first eligible pre-step (`dsh-agent-instructions/lib/index.js:1130-1180`);
  **changes/removals** come from `reconcileInstructionContext` (`:907`) via `renderInstructionChanges`
  (`:230`), and **removals** render as `Instructions removed: <path>` (`:215`).
- **Pending is an inbox, not a direct append.** `syncInbox` prepends/replaces in
  `agent.inbox.nextStep` (`dsh-agent-instructions/lib/index.js:1210-1229`); `session/event` `step/end`
  drains touches (`:1263-1269`).
- The plugin's only injected service is `sessionProjections` (`dsh-agent-instructions/lib/index.js:1072`).
  **It publishes no service** — see §5.

---

## 2. Other instruction conventions — what actually exists

Searches run across the whole install (`@deepseek-ai/**` under the tree above), with `include: *.js`
for source and an unfiltered pass for the rarely-spelled strings.

| String | Real hits | Verdict |
|---|---|---|
| `AGENTS.md` | `dsh-agent-instructions/lib/index.js:17,141,148,756,1062` — **only** this package | no other discoverer |
| `CLAUDE.md` / `CLAUDE.local.md` | `dsh-agent-instructions/lib/index.js:17,18` only | same package's candidate list |
| `AGENTS.local.md` | `dsh-agent-instructions/lib/index.js:18` | same |
| `.cursor` | `dsh-agent-instructions` — none. All `.cursor` matches are DOM `style.cursor` and pagination `cursor` fields (e.g. `dsh-api-gateway/lib/client.js:1093`, `dsh-client-ui-sidebar-documentpreview/lib/client.js:7416-7418`, `dsh-session-query-sqlite/lib/index.js:547`) | **no Cursor convention support** |
| `cursorrules`, `.cursor/rules` | **No matches found** (whole-install grep) | nothing |
| `CLAUDE` (other packages) | `dsh-hooks-claude-code/lib/index.js:13-21` is a list of Claude Code *hook event names* (`SessionStart`, `PreToolUse`, …); `:34-35` substitutes `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PROJECT_DIR}` in a hook command string | hook-event bridge, **not** document discovery |
| `instructions` | Only `agent-instructions` identifiers plus the generic `form: 'instructions'` context form | see above |
| `memory` | Only a settings-persistence mode: `dsh-client-ui-settings/lib/client.js:1075,1237,1253,1345`; `dsh-client-ui-settings-models/lib/client.js:2504,2535` | **no memory-file convention** |
| `projectDoc` | **No matches found** (whole-install grep) | nothing |
| `agentsFiles` | **No matches found** (whole-install grep) | nothing |
| `.agents/skills`, `.dsh/skills` | `dsh-skill-filesystem/lib/index.js:155,160` | **skill** roots, not constraint docs |
| `.agents/notes/...` | ~20 hits, all inside JSDoc/comments citing DSH's own repo notes (e.g. `dsh-compaction/lib/index.js:141`, `dsh-session/lib/index.js:54`) | documentation citations, never read at runtime |

**User-configurable?** Only through the plugin row's `config`, whose schema exposes
`projectRootMarkers`, `maxBytes`, `maxSourceBytes`, `instructionFileCandidates`,
`localInstructionFileCandidates`, `dshHome` (`dsh-agent-instructions/lib/index.js:25-32`). It
registers **no settings namespace** (its `inject` is only `sessionProjections`,
`dsh-agent-instructions/lib/index.js:1072`), and **no shipped row overrides any candidate field** —
every mounting row sets only `maxBytes` (`dsh-base/cordis.patch.yml:268-271`,
`dsh-agent-presets/presets/cordis/agent.cordis.yml:32-35`, `.../presets/standard/agent.cordis.yml:31-32`,
`.../presets/ptc/agent.cordis.yml:38-39`). So `CLAUDE.md` support is on by default, and a *different*
convention requires editing a composition row's `config`.

One composition-plane nuance worth recording: the Web host patch **disables** the host-plane row
outright — `- id: agent-instructions` / `disabled: true`
(`dsh-web-app/cordis.patch.yml:464-465`) — because "the agent plane moves behind agent presets"
(`:351`, `:356`): each session mounts its own preset row instead. That is why instruction loading is
a *preset* concern in a Web session, and it is the place a deployment would change candidates.

---

## 3. Skills discovery — and yes, it is a queryable service

**Owner of the registry:** `@deepseek-ai/dsh-skill@0.1.5-rc.2`.

`SkillRegistry extends Service` registers the key **`skills`**:
`super(ctx, "skills")` at `dsh-skill/lib/index.js:132`. Interface (source + confirmed by
`Service.listService`):

- `registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void` — `dsh-skill/lib/index.js:147`
- `register(skill: SkillRegistration): () => void` — `dsh-skill/lib/index.js:193`
- `async list(options: SkillViewOptions = {}): Promise<SkillSummary[]>` — `dsh-skill/lib/index.js:224`
- `async snapshot(options: SkillViewOptions = {}): Promise<SkillCatalogSnapshot>` — `dsh-skill/lib/index.js:234`
- `async get(name: string, options: SkillViewOptions = {}): Promise<SkillDefinition | undefined>` — `dsh-skill/lib/index.js:250`

`list`/`snapshot` return invocation-neutral summaries (`name`, `description`, `whenToUse`,
`invocation`, `source`, `provider`, `resourceBase`) — `toSummary` at `dsh-skill/lib/index.js:491-502`.
`get()` returns the **full definition including the `SKILL.md` body** as `content`
(`validateDefinition` requires `typeof content === "string"`, `dsh-skill/lib/index.js:488`;
provider returns it at `dsh-skill-filesystem/lib/index.js:132`).

**Provider and scanned directories:** `@deepseek-ai/dsh-skill-filesystem@0.1.5-rc.2`,
`inject = ["skills"]` (`dsh-skill-filesystem/lib/index.js:30`), registering via
`ctx.skills.registerProvider` (`:48`). `roots(cwd)` (`:150-188`) yields, in rank order:

| Root | `source` | rank | Cite |
|---|---|---|---|
| `<projectRoot>/.dsh/skills` | `project-dsh` | 100 | `dsh-skill-filesystem/lib/index.js:154-158` |
| `<projectRoot>/.agents/skills` | `project-agents` | 200 | `:159-164` |
| each `customSkillDirs` entry | `custom` | 300 | `:166-170` |
| `<dshHome>/skills` (`skipSystem`) | `user-dsh` | 400 | `:171-175` |
| `<agentsHome>/skills` (`$DSH_AGENTS_HOME` or `~/.agents`) | `user-agents` | 500 | `:176-180`, default at `:78` |
| `bundledSkillDir` (`$DSH_BUNDLED_SKILL_DIR`) | `bundled` | 600 | `:181-186`, default at `:84` |

Per root, a subdirectory contributes `<dir>/SKILL.md` and a flat file contributes `<name>.md`;
YAML frontmatter is parsed for `name`/`description`/`whenToUse`/`invocation`
(`dsh-skill-filesystem/lib/index.js:581-613`, locator rule at `:586-592`). Duplicate names resolve by
lowest rank then registration order (`compareIndexedCandidates`, `dsh-skill/lib/index.js:518-520`),
with the nearest scope layer winning outright (`collectFresh`, `dsh-skill/lib/index.js:298-311`).

**Does a service expose the resolved list at runtime? YES — `ctx.skills`.**
Live proof of consumption: `dsh-tool-skill` declares `inject = ["agents","tools","skills"]`
(`dsh-tool-skill/lib/index.js:35-39`) and calls
`await ctx.skills.snapshot({ cwd: agent.session.header.cwd, signal, scope: agent })`
(`dsh-tool-skill/lib/index.js:207-210`). A second, Remote-only façade exists —
`sessionSkillCatalog` ("Host service backing `ctx.remote.skills` without activating a cold Agent",
`dsh-api-session-controller/lib/index.js:2201`), registered as
`super(ctx, "sessionSkillCatalog", { namespace: "skills" })`
(`dsh-api-session-controller/lib/index.js:2235`) with `@Remote async list(request, signal)`
(`:2245`).

**How the catalog reaches the model** (useful as a precedent for an out-of-tree plugin): `dsh-tool-skill`
runs its *own* `agent/pre-step` listener (`dsh-tool-skill/lib/index.js:203`) and appends a durable
user message whose source is `{ kind: "skill-catalog", form: "catalog", entries }`
(`:238-261`, update variant `:262-286`). It is again a **history message**, mirroring
`agent-instructions`. Both source kinds are admitted by the session-format migration's
`SOURCE_KINDS` set (`dsh-session-format-v2-to-v3/lib/index.js:14-30`, `"agent-instructions"` at `:19`,
`"skill-catalog"` at `:24`).

---

## 4. ADRs / domain docs — nothing does this

**Nothing in the installed tree discovers `docs/adr/`, `CONTEXT.md`, `CONTEXT-MAP.md`, or a spec
directory.** Stated plainly, with the searches run:

- `grep -i 'CONTEXT\.md|docs/adr|/adr/|specs?/|memory/'` over `@deepseek-ai/**/*.js` → **No matches found**.
- `grep 'cursorrules|\.cursor/rules|CONTEXT-MAP|projectDoc|agentsFiles'` over the **entire install,
  all file types** → **No matches found**.
- The only `adr`-shaped hits in the whole install are unrelated substrings inside the bundled web
  frontend's base64 font/`bcmap` assets and `REQUEST_ENVELOPE_HEADROOM_BYTES`
  (`dsh-client-connection/lib/index.js:728`), i.e. false positives, not ADR support.

There is consequently **no harness-resolved identifier, no ADR number, and no section anchor** for
constraint documents. The finest identifier the harness itself records is a *file* identity —
`changes[].scope` (`"<dir>\0<candidateName>"`) and `changes[].path` plus a SHA-1 `digest`
(`dsh-agent-instructions/lib/index.js:844-851`, `:163-165`; the whole-block digest is
`instructionContentSha1`, `:90-92`).

---

## 5. Queryable services for "which constraint documents apply here?"

I enumerated the live Host service catalog via `Service.listService`. **There is no service for
instruction/constraint documents.** The catalog contains no `instructions` or `agentInstructions`
key; `dsh-agent-instructions` publishes nothing (`inject = ["sessionProjections"]`,
`dsh-agent-instructions/lib/index.js:1072`) and exports only plain functions —
`export { Config, apply, discoverBaselineInstructionFiles, inject, loadBaselineInstructions, name, renderWorkspaceContext }`
(`dsh-agent-instructions/lib/index.js:1311`; types at `dsh-agent-instructions/lib/types/index.d.ts:16-20`).

What *does* exist, and what each returns:

| Service | Interface (path:line) | Returns |
|---|---|---|
| `skills` | `list(options)`, `snapshot(options)`, `get(name, options)` — `dsh-skill/lib/index.js:224,234,250` | resolved skill summaries, or a full `SKILL.md` body. **Not constraint docs.** |
| `workspaceRegistry` | `get(id)`, `list()`, `resolveByPath(path)` — `dsh-workspace/lib/index.js:375,384`; typed at `dsh-workspace/lib/types/index.js:132,141` | durable workspace entities keyed by canonical path. Gives *which workspace*, never *which documents*. |
| `sessions` | `get(id)`, `list()`, `create/fork/…` — `super(ctx, "sessions")` at `dsh-session/lib/index.js:1315` | live `Session` objects; `session.header.cwd` is the only cwd source a plugin needs. |
| `systemPrompt` | `section()`, `context()`, `variable()`, `tools()`, `assemble(context)` — `dsh-system-prompt/lib/index.js:238,264,295,284,308` | `section`/`context`/`variable` are **registration-only**; the single reader is `assemble()`, which returns assembled sections+context for the caller's scope. It cannot attribute a section back to a file, and `agent-instructions` does not use it. |
| `agents` | `get(id)`, `list()` | live `Agent` handles (`{ id }` per the `agent/pre-step` contract). |
| `sessionSkillCatalog` | `@Remote async list(request, signal)` — `dsh-api-session-controller/lib/index.js:2245` | Remote skill list façade. |
| `fs` | `resolve`, `stat`, `readText`, `listDir`, `streamText`, … | the primitive for any self-rescan. |

**Bottom line for §5: no service answers the question.** A plugin can learn *where* it is
(`sessions.get(id).header.cwd`, `workspaceRegistry.resolveByPath`) and *which skills exist*
(`skills`), but nothing hands it the list of applicable `AGENTS.md`/`CLAUDE.md` documents.

---

## 6. Plugin-authoring implication — least-duplicative route

Options, grounded in the above:

**(a) Query an existing service — not available for constraints.** §5 shows no such service. Partial
value only: `sessions.get(id).header.cwd` for the cwd, `workspaceRegistry.resolveByPath(path)` for
the workspace record, `ctx.fs` for raw reads.

**(b) Hook an existing event that already carries the resolved content — VIABLE, and the best fit.**
The resolved documents are already durable, first-party session facts. The exact predicate the
harness itself uses is:

```js
event?.type === "user/message" && event.data.source.kind === "agent-instructions"
```
`dsh-agent-instructions/lib/index.js:825`, `:1077`, `:1212-1214`.

Two ways to consume it:
- **Read history:** iterate `agent.session.surface.nodes` and `agent.session.eventAt(seq)`
  (`dsh-agent-instructions/lib/index.js:823-828`, `:1075-1078`) — the schema is on the live
  `session/event` contract (`dsh-session/lib/index.js` `Session` class: `surface`, `eventAt`,
  `snapshotEvents`, `deriveMessages`).
- **Listen:** `ctx.on("session/event", (session, event) => …)` — an `emit`-mode, post-commit
  append feed (`Event.listEvents` contract; the plugin's own listener at
  `dsh-agent-instructions/lib/index.js:1263`). Match `event.type === "user/message"` and
  `event.data.source.kind === "agent-instructions"`, then read
  `source.changes[]` = `{ action: "set"|"replace"|"remove", scope, path, digest }`
  (`dsh-agent-instructions/lib/index.js:802-817`).

What this gives you: the **set of files in effect**, each with a stable `path` + content `digest`,
and the body text whose headings are `Instructions from: <displayPath>` /
`Additional instructions from: <displayPath>` (`dsh-agent-instructions/lib/index.js:130-132`,
`:191-200`). That is exactly enough for "cite which pre-agreed constraint you deviated from" at
*file* granularity.

⚠️ **Precise caveat about `agent/pre-step`.** Cordis waterfall listeners "run outermost-first"
(`cordis/lib/index.js:307-325`, doc comment at `:310-312`). `agent-instructions` registers with a
plain `ctx.on` (push → innermost) and inserts its own message into the value returned by `next()`
(`dsh-agent-instructions/lib/index.js:1271-1283`). A plugin that registers **later without
`prepend`** runs *inside* `next()` and therefore **will not see the baseline message**. To observe
it you must be outermost: `ctx.on("agent/pre-step", handler, true)` — a boolean third argument is
shorthand for `prepend` (`cordis/lib/index.js:371-372`, documented at `:386`). `dsh-tool-skill`
sidesteps this entirely by reading durable history rather than the entering batch
(`dsh-tool-skill/lib/index.js:203-236`). **Prefer history over the entering batch.**

**(c) Re-scan the filesystem — only for documents the harness does not know about.**
Necessary for `docs/adr/`, `CONTEXT.md`, or a spec directory, since §4 shows nothing discovers them.
But for `AGENTS.md`/`CLAUDE.md` it would duplicate the root-marker walk
(`dsh-agent-instructions/lib/index.js:480-488`), the ancestor chain (`:495-508`), candidate
ordering (`:578`), per-directory dedup (`:632-648`), and the byte budget (`:293-372`) — and it would
**diverge silently** the moment a profile overrides `instructionFileCandidates` in its composition
row (the schema supports it, `dsh-agent-instructions/lib/index.js:30-31`; no shipped row does).

**(d) Instruct the model to cite by convention without the plugin knowing the list — cheapest, and
a good complement.** The harness already tells the model "More specific instructions take precedence
over broader ones" (`dsh-agent-instructions/lib/index.js:113`) and every injected block is headed by
its own path (`:131`, `:194`). So a pure-prompt citation rule (`cite path, or path#heading`) needs
no discovery and no new state. Its weakness: the plugin cannot *validate* the citation, so a
deviated-constraint audit built only on (d) is unfalsifiable.

**(c′) A fourth route for real (non-dynamic) plugins.** `discoverBaselineInstructionFiles(options)`
is genuinely exported (`dsh-agent-instructions/lib/index.js:1311`) and typed with `cwd`, optional
`dshHome`/`projectRootMarkers`/candidate lists, and `signal`
(`dsh-agent-instructions/lib/types/files.d.ts:26-34`, `:97`), resolving `$DSH_HOME` itself
(`lib/index.js:69`). An out-of-tree **npm plugin** can therefore `import` it and get the harness's
own answer without duplicating the rule. This is the closest thing to "asking the harness". A
**dynamic Cordis plugin cannot** — the restricted sandbox forbids `import`/`require`, so route (b)
is the equivalent for that case.

### Recommendation

**Route (b) as the primary mechanism, with (d) for the citation contract, and (c) confined to the
docs the harness provably ignores.**

1. Discover the *files in effect* by reading the durable `agent-instructions` messages from session
   history / the `session/event` feed (predicate and field shapes above) — never by re-walking the
   project root. Use `changes[].path` + `digest` as the stable file identifier; this automatically
   respects whatever candidate lists and root markers the mounting composition configured.
2. Ask the model to cite `<path>` (and, if needed, `<path>#<heading>`) — the harness already injects
   both the path heading and the precedence rule, so no new prompt plumbing is strictly required.
3. For `docs/adr/` and `CONTEXT.md` there is no harness convention to ask for (§4), so treat those
   as *this plugin's own* convention: a small, explicitly-documented scan of the ADR/spec directory
   is unavoidable and is not duplication of harness logic.
4. Do **not** hardcode `AGENTS.md`/`CLAUDE.md` file names in the plugin. Read them from the events.
   If a future profile adds e.g. `.cursor/rules`, the plugin picks it up for free.

---

## 7. Installed versions of cited packages

All `0.1.5-rc.2` unless noted; each read from the package's own `package.json`.

| Package | Version | Cited in |
|---|---|---|
| `@deepseek-ai/dsh-agent-instructions` | 0.1.5-rc.2 | §1, §2, §5, §6 |
| `@deepseek-ai/dsh-skill` | 0.1.5-rc.2 | §3, §5 |
| `@deepseek-ai/dsh-skill-filesystem` | 0.1.5-rc.2 | §3 |
| `@deepseek-ai/dsh-tool-skill` | 0.1.5-rc.2 | §3, §6 |
| `@deepseek-ai/dsh-system-prompt` | 0.1.5-rc.2 | §5 |
| `@deepseek-ai/dsh-workspace` | 0.1.5-rc.2 | §5 |
| `@deepseek-ai/dsh-session` | 0.1.5-rc.2 | §5, §6 |
| `@deepseek-ai/dsh-session-format-v2-to-v3` | 0.1.5-rc.2 | §3 |
| `@deepseek-ai/dsh-api-session-controller` | 0.1.5-rc.2 | §3, §5 |
| `@deepseek-ai/dsh-base` | 0.1.5-rc.2 | §2 |
| `@deepseek-ai/dsh-agent-presets` | 0.1.5-rc.2 | §2 |
| `@deepseek-ai/dsh-hooks-claude-code` | 0.1.5-rc.2 | §2 |
| `@deepseek-ai/cordis` | **4.0.2** | §6 |

---

## Negative findings (explicit)

1. **No service exposes the resolved instruction/constraint document list.** Verified against the
   live Host service catalog via `Service.listService`: no `instructions`/`agentInstructions` key
   exists. `dsh-agent-instructions` injects `sessionProjections` only and publishes nothing
   (`dsh-agent-instructions/lib/index.js:1072`, `:1311`).
2. **Nothing discovers `docs/adr/`, `CONTEXT.md`, `CONTEXT-MAP.md`, or a spec directory.** Greps
   listed in §4.
3. **Nothing supports `.cursor/rules`, `.cursorrules`, `projectDoc`, or `agentsFiles`.** Whole-install
   grep → no matches.
4. **No memory-file convention exists**; `memory` appears only as a client settings-persistence mode.
5. **No user-facing settings namespace for instruction candidates** — row config only, and no shipped
   row overrides the defaults.
6. **No watcher.** Instruction refresh is touch-driven on first-party `read`/`write`/`edit`
   (`dsh-agent-instructions/lib/index.js:1086-1097`, `:1289-1308`; `README.md:214-215`). A plugin that
   edits an `AGENTS.md` directly cannot rely on the harness noticing immediately.
7. **No section-level or ADR-level identifier is recorded anywhere.** The finest durable identity is
   file path + SHA-1 digest (`dsh-agent-instructions/lib/index.js:844-851`, `:90-92`).

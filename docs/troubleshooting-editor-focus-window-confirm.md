# Troubleshooting: Editor Focus Loss Caused by Native window.confirm (WIN-BLUR)

This document explains a fixed bug in the MarkFlow desktop app (Electron + React +
CodeMirror 6) where the editor became unable to receive keyboard input after
switching away from a document that had unsaved changes.

It is written as a public reference. It describes the **symptom**, the **root
cause** and mechanism (so the lesson generalises to other Electron apps), the
**fix**, and — because this bug was unusually deceptive — a candid account of
the **wrong turns, what was excluded and why, and the lessons learned**.

---

## 1. Symptom

1. Open document A, enter **edit** mode, type something (so it becomes _dirty_).
2. Switch to document B from the sidebar.
3. The "unsaved changes" confirm box appears; choose **Discard** (or **Keep editing**).
4. The editor appears focusable, but **typing produces no characters**.
   Clicking, scrolling, and the caret all behave, yet no text is inserted.
5. Pressing `Alt-Tab` away and back restores input immediately.

The bug reproduced only on the **dirty** path. In the user's tested scenario
(editing mode, then switching), having **no unsaved changes never broke
typing**.

> **Honesty note on scope.** The above "no unsaved changes → fine" was verified
> by the user in **edit mode** (they had entered edit mode before switching, so
> `editable=true`, focus on `cm-content`; it simply did not break _because no
> confirm was shown_). Whether switching in genuine **read-only mode** also
> breaks was **never verified** and must not be asserted. The only established
> fact is: in edit mode, `dirty=true` always breaks, `dirty=false` never breaks
> (because no `window.confirm` → no WIN-BLUR). Do not generalize to read-only
> mode.
>
> **Fix acceptance criterion:** after switching away from a dirty document, the
> editor must be directly typeable **without** clicking it first and **without**
> `Alt-Tab`. "Click once and it works" is _not_ a fix.

---

## 2. What was actually happening

### 2.1 Keystrokes reached CodeMirror, but the browser suppressed input

Instrumentation confirmed that `keydown` events _did_ arrive at `cm-content`,
`activeElement === cm-content`, and `readOnly === false` — yet
`document.hasFocus() === false` (even though `mainWindow.isFocused()` reported
`true`).

CodeMirror accepts text only from the browser's `input`/`beforeinput` events on
the contenteditable element. Those events are dispatched **only when the
document has OS focus**. Because `document.hasFocus()` was stuck `false`, the
browser never fired them, so keystrokes produced no text. CodeMirror's keymap
(Enter/Backspace/Tab) is driven by `keydown` and still worked, which made the
failure look like "only character input is broken".

### 2.2 `document.hasFocus` is a real OS-focus flag, not an internal state

From `@codemirror/view`:

```js
get hasFocus() {
  return (this.dom.ownerDocument.hasFocus() || /* safari quirk */) &&
         this.root.activeElement == this.contentDOM
}
```

`view.hasFocus` is just `document.hasFocus() && activeElement === cm-content`.
It does **not** gate input — but `document.hasFocus() === false` makes the
_browser_ withhold `input` events, which indirectly blocks editing.

> **Two-layer focus, do not conflate them.** There are two different "focus"
> flags in this bug, and confusing them is what made the investigation drag on:
>
> - `view.hasFocus` (CodeMirror-internal getter = `document.hasFocus() &&
activeElement === cm-content`): on the dirty path this flips to `false` at
>   `EDIT-EFFECT-START` **because `editable` becomes `false` and `activeElement`
>   is no longer `cm-content`** — that is _expected_ in read-only mode and is
>   **NOT** the bug signal. The same flip happens on the clean path too.
> - `document.hasFocus()` (the OS-window-level flag): this is the real signal.
>   It stays `true` the whole time on the clean path but gets pinned `false` on
>   the dirty path. Only the latter is the actual defect.
>   So "`view.hasFocus === false`" by itself means nothing — the bug is the
>   _outer_ `document.hasFocus()` being stuck `false`.

### 2.3 Root cause: `window.confirm` fires an OS-level window blur

The confirm box shown before switching was a native **`window.confirm`** — an
**OS-modal** dialog.

- While the dialog is open, it does **not** steal focus (`document.hasFocus()`
  stays `true` before and after showing it — this was proven by `CONFIRM`
  probes recording `hasFocus=true` both before and after the dialog on
  `Sidebar.handleSelectDoc`).
- The instant the dialog **closes**, Chromium fires a real `window` `blur`
  event (`relatedTarget === null`): the renderer window genuinely loses OS
  focus, and `document.hasFocus()` is set to `false`. Electron does **not**
  automatically return focus to the renderer after a `window.confirm` closes.

> **Crucial distinction that delayed diagnosis.** "The dialog does not steal
> focus while open" was misread early on as "confirm is therefore innocent."
> It is not: the OS blur fires on **close**, not while open. So `window.confirm`
> is the root cause (it fires the WIN-BLUR on close), yet it is _not_ "stealing
> focus during the dialog" — that wording was explicitly disproven and must not
> be reused.
>
> Throughout this document, `TL#n` (e.g. `TL#22`) refers to a global sequential
> time-line log line emitted by the debug instrumentation (`tlSeq` counter in
> `src/renderer/src/store/ui.ts`). `WIN-BLUR` / `WIN-FOCUS` are the renderer-side
> `window` `blur` / `focus` event probes; `DEFER-SWITCH` / `DEFER-SWITCH-FIRE`
> mark the deferred `setActiveDocumentId` callback used in round 12 (3.5i-A).

The subsequent `setActiveDocumentId` (which forces read-only mode and
re-renders the editor pane) only _inherits_ that `false` state; it is **not**
the thing that cleared focus.

Why only the dirty path breaks:

- **dirty = true** → `window.confirm` is shown → OS blur on close →
  `document.hasFocus()` stuck `false` → typing broken.
- **dirty = false** → no `window.confirm` → no OS blur → `document.hasFocus()`
  stays `true` → typing fine.

### 2.4 Why `Alt-Tab` "fixes" it (and nothing in-app did)

`Alt-Tab` is a genuine OS-level focus event, so Chromium recomputes
`document.hasFocus()` and returns focus to the renderer → input resumes.

Any in-app attempt to recover focus was a **no-op** while the window had no OS
focus:

- `element.focus()` / `window.focus()` / `view.focus()` only move
  `activeElement`; they do not make Chromium recompute `document.hasFocus()`.
- A main-process `webContents.focus()` / `executeJavaScript('window.focus()')`
  IPC is also a no-op **when the window is already foreground** (it only emits a
  real focus event when the window is _not_ focused). During the bug the window
  _was_ foreground, so the IPC did nothing. (Caveat: a _manually_ typed
  `webContents.focus()` in the Console may appear to work — because then the
  window is genuinely _not_ foreground and the call emits a real focus event.
  That manual success must not be confused with the in-app call, which runs
  while the window is already foreground. See §4.5.)

This is the key lesson: once an OS-modal dialog has blurred the window, you
cannot "focus your way back" from inside the app. You must **not trigger the
blur in the first place**.

---

## 3. Fix — replace `window.confirm` with an app-modal dialog

The reliable fix is to stop using the OS-modal `window.confirm` and instead use
a dialog that does **not** blur the renderer window:

- **Renderer-side React modal** (e.g. a Radix `Dialog`): it overlays the app
  but focus never leaves the window, so no OS blur occurs.
- **Main-process `dialog.showMessageBox`**: this is **app-modal**, not
  OS-modal. Electron returns focus to the calling window after it closes, so
  `document.hasFocus()` stays `true`.

MarkFlow adopted the second form (`dialog.showMessageBox`) because it was the
smallest change across the six call sites and inherently "returns focus on
close".

### 3.1 New IPC

`electron/main/index.ts` registers a single handler:

```ts
ipcMain.handle(
  'dialog:confirm',
  async (
    _event,
    opts: { message: string; detail?: string; okText?: string; cancelText?: string },
  ): Promise<boolean> => {
    const result = await dialog.showMessageBox({
      type: 'question',
      buttons: [opts.cancelText ?? 'Cancel', opts.okText ?? 'OK'],
      defaultId: 1,
      cancelId: 0,
      message: opts.message,
      detail: opts.detail,
    })
    return result.response === 1
  },
)
```

`electron/preload/index.ts` exposes it on the `dialog` object:

```ts
confirm: (opts) => ipcRenderer.invoke('dialog:confirm', opts),
```

and `src/renderer/src/vite-env.d.ts` declares `Api.dialog.confirm` as
`Promise<boolean>`.

### 3.2 Call sites (all six `window.confirm` replaced)

| File                                                | Location                   | Behaviour                                                                                                                                                                                           |
| --------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/components/sidebar/Sidebar.tsx`   | `handleSelectDoc`          | `async`; `await window.api.dialog.confirm(...)` before switching                                                                                                                                    |
| `src/renderer/src/components/sidebar/Sidebar.tsx`   | close-workspace button     | `async`; same confirm                                                                                                                                                                               |
| `src/renderer/src/App.tsx`                          | `tryCloseWorkspace`        | **kept synchronous** (returns `boolean` for the `before-quit` flow); on dirty it returns `false` and fire-and-forgets the confirm, then `closeWorkspace()` + `window.api.app.allowQuit()` on accept |
| `src/renderer/src/App.tsx`                          | `close-file` menu callback | `async` + `await`                                                                                                                                                                                   |
| `src/renderer/src/App.tsx`                          | `handleDrop`               | `async` + `await`                                                                                                                                                                                   |
| `src/renderer/src/components/editor/EditorPane.tsx` | `handleClose`              | `async` + `await`                                                                                                                                                                                   |

> Of these six, only `Sidebar.handleSelectDoc`'s **dirty-path** confirm is the
> **actual root-cause call site** (the 12th-round conclusion: its `window.confirm`
> close fires `WIN-BLUR`, see §4.2 / `logs_3.5i-A_dirty_true.log` TL#22). The
> other five are **same-root risk points** — they also contain a native
> `window.confirm` and would trigger the same `WIN-BLUR`, but they lie outside
> this bug's reproduction path. Fix B replaced all six so the class of defect is
> eliminated wholesale rather than only at the repro site.

`shared/i18n/en.ts` / `zh-CN.ts` gained two button labels:
`app.confirmDiscard` ("Discard" / "丢弃") and `app.confirmKeep`
("Keep editing" / "继续编辑").

### 3.3 Why this fixes it

`dialog.showMessageBox` is app-modal. When it closes, Electron restores focus to
the renderer window, so **no `window` `blur` is left behind** and
`document.hasFocus()` remains `true`. The editor is immediately typeable after
switching — no `Alt-Tab` required.

> **A legitimate `pointerdown → focus` fallback still exists in `MarkdownEditor.tsx`
> — this is _not_ a leftover probe.** After the fix, the editor keeps a
> `handlePointerDown` handler that focuses the editor on a real user click. That is
> normal UX (a user clicking the text area should focus it) and is completely
> independent of the WIN-BLUR bug; it is _not_ the focus-recovery hack from the
> investigation (that hack used `view.focus()`/`window.focus()` programmatically,
> which was proven a no-op and removed). Do not mistake this production handler for
> residual instrumentation.

### 3.4 Verification

After the fix: edit document A (dirty) → switch to B → an app-native message
box appears → confirm discard → the editor is typeable **immediately**, with
`document.hasFocus()` staying `true` and no stuck `blur`. The same holds for
close-file, close-workspace, and drop handlers. Verified on Windows.

> **Why we are certain this is project-specific, not a platform bug.** A minimal
> standalone Electron + CodeMirror repro using the _same_ `electron@43.2.0` and
> `@codemirror/*` versions on the same Windows 11 typed normally through the
> identical "switch → edit" flow with `document.hasFocus() === true` (see §4.2,
> "Platform defect?" exclusion). That decisive evidence rules out Electron 43 /
> Windows 11 / CodeMirror as the cause; the trigger is purely the project's
> `window.confirm` on the dirty path.
>
> **Honesty scope (read-only mode unverified).** As stated in §1, whether
> switching in _genuine read-only mode_ also breaks was **never verified**. The
> only established facts are: in edit mode, `dirty=true` always breaks and
> `dirty=false` never breaks (because no `window.confirm` → no WIN-BLUR). Do not
> generalize to read-only mode.
>
> **Diagnostic probes have been cleaned up.** The debug instrumentation
> (`[TL#n]` time-line, renderer `WIN-FOCUS`/`WIN-BLUR`/`FOCUS-RECOVER`,
> `[focus-diag-main]`, `DEFER-SWITCH`/`DEFER-SWITCH-FIRE`) was removed after the
> fix landed. (If you grep the codebase you should find _no_ `tlSeq`, `WIN-BLUR`,
> `DEFER-SWITCH`, `focus-diag`, `blurEvents`, or `totalWindows` left in `src/` or
> `electron/`.) The only focus-related code that remains is the legitimate
> production fallback described below.

Acceptance criterion (from real-device logs): on the dirty path there must be
**no `WIN-BLUR` event during the switch**, and the outer `document.hasFocus()`
must stay `true` the entire time (from `DOC-SWITCH#1` through `EDIT-EFFECT-START`
and after). Any `WIN-BLUR` with `relatedTarget === null` (no focus transferred
elsewhere) is the precise indicator the fix regressed. The behavioral bar is also
non-negotiable: after switching away from a dirty document the editor must be
directly typeable **without** clicking it first and **without** `Alt-Tab` — "click
once and it works" is _not_ a fix.

---

## 4. Investigation: wrong turns, exclusions, and lessons

This bug was deceptive: the visible symptom (a re-render on file switch) pointed
away from the real cause (a native dialog closing). The following is the
investigative trail, kept as a cautionary record.

### 4.1 Approaches tried and rejected (dead ends)

- **Removing the editor `key`.** `<MarkdownEditor key={activeDocumentId}>` was
  suspected of remounting the `EditorView` on switch, so the `key` was removed
  to keep the view persistent. The bug still reproduced → remount was not the
  cause.
- **`isolateHistory` annotation.** An annotation was added around the
  switch dispatch to isolate undo history → still reproduced.
- **Programmatic focus recovery.** `view.focus()`, `contentDOM.focus()`,
  `window.focus()` with `setTimeout` retries → never restored
  `document.hasFocus()`.
- **Main-process focus IPC evolution.** `mainWindow.focus()` → + `webContents.focus()`
  → + `setAlwaysOnTop(true)` (which wrongly pinned the window on top and still
  failed) → reverted to the minimal form → still a no-op when the window was
  already foreground.
- **`sandbox: false`.** Tried in case the sandbox suppressed focus reporting →
  still reproduced (kept afterwards, harmless).
- **"Focus left dangling on an unmounted control".** `document.activeElement`
  was blurred before switching to prevent a dangling focus → still reproduced;
  a manual check showed `activeElement` was already `cm-content` and connected,
  yet `document.hasFocus()` was false.
- **"Sibling DOM steals focus on switch".** The title `<input autoFocus>` and
  the formatting toolbar only render in edit mode, so they unmount/rebuild on
  switch. Proven false: instrumentation recorded **no** blur events on those
  elements, and `activeElement` had already fallen to `BODY` _before_ the
  switch, not on a sibling unmount.
- **"`editable` toggle rebuilds the cm-content DOM and drops focus".**
  Temporarily disabled the forced `editable:false` on switch (leaving the
  editor completely untouched) → still reproduced. This ruled out any
  `EditorView` reconfigure/dispatch as the cause. Concretely, the cleanest single
  variable was **subtraction 0**: in `src/renderer/src/store/ui.ts` the
  `editable: false` was commented out of `setActiveDocumentId`, so `editable`
  stayed `true` for the entire run and the `EditorView.editable` facet **never
  flipped** (`readOnlyFacet=false`, `editableFacet=true` throughout) — yet
  `document.hasFocus()` still flipped to `false` at `DOC-SWITCH#1`. That
  definitively severed the "editable toggle → DOM rebuild → focus loss" chain.
- **"Switching unmounts the editor subtree via `isLoading`/`!doc`."** Another
  suspect was that `useDocument(activeDocumentId)` (react-query with
  `staleTime: 0`) returns `isLoading=true` / `doc=undefined` on switch, causing
  `EditorPane` to briefly return `<Loading/>` / `<NotFound/>` and unmount the
  whole editor subtree for a frame. This was excluded by caching the last doc
  (`const doc = docData ?? lastDocRef.current`) so the subtree never unmounted —
  the bug **still** reproduced. Notably, this was the run that first captured a
  real `WIN-BLUR` event (before then, logs showed no `WIN-BLUR` and the bug was
  mis-modeled as a "silent" flag reset), which redirected the investigation from
  "Chromium focus-flag mismatch" toward "something really blurs the window".
- **"Confirm blocks the event loop and a deferred re-render would fix it."**
  See §4.3 — deferred via `setTimeout(…, 0)` and the bug still reproduced before
  the re-render, which killed the batching theory.
- **Real `pointerdown` gesture.** Clicking the editor repeatedly in the dead
  state still left `document.hasFocus()` false → no recovery.
- **Fallback bridge.** Capturing `keydown` and manually dispatching it, plus
  toggling a `cm-focused` class by hand. This treated the symptom, not the
  cause, and was reverted.
- **Misled by the main-process focus flag.** `[focus-diag-main]` reported
  `main.isFocused=true`, `blurEvents=0`, `totalWindows=1` for the whole run, so
  the OS window was judged "perfectly fine" and the "OS focus stolen" direction
  was dismissed. That was wrong: the renderer-side `WIN-BLUR` _did_ fire and the
  renderer really lost OS focus, while Electron's `main.isFocused` simply did
  not reflect it. Chromium's `document.hasFocus` and Electron's `isFocused` can
  disagree in this environment — never trust the main-process flag alone (see
  §4.5).
- **Component-level focus red herrings (Radix Tooltip/Popover, title `<input
autoFocus>`, formatting toolbar).** These were suspected because they only
  render in edit mode and unmount/rebuild on switch. They were excluded
  directly: instrumentation recorded **no** blur events on those elements, and
  `activeElement` had already fallen to `BODY` _before_ the switch (see the
  "Sibling DOM steals focus" dead end above) — Radix `Tooltip`/`Popover` focus
  management was checked and likewise ruled out. No `relatedTarget`/`stack` trace
  was needed: `relatedTarget === null` on the WIN-BLUR already showed focus went
  nowhere, i.e. nothing in the component tree grabbed it.

### 4.2 Key exclusions (why those directions were wrong)

- **Platform defect (Electron / Windows / CodeMirror)?** A minimal standalone
  Electron + CodeMirror app using the _same_ `electron@43.2.0` and
  `@codemirror/*` versions (and the same Windows 11) typed normally through the
  same "switch → edit" flow with `document.hasFocus() === true` and letters
  entering fine. The bug is project-specific (the `window.confirm` on the dirty
  path), **not** a framework/platform bug. This minimal-repro was the decisive
  piece of evidence that ruled out Electron 43 / Windows 11 / CodeMirror.
- **React re-render / `editable` toggle?** The editor could be left completely
  untouched and the bug still reproduced; the trigger is purely the OS blur
  from `window.confirm` closing. Note also: in read-only mode the focus is
  _plausibly_ already on `BODY` (not in the editor), so a switch there _might_
  produce no perceptible "can't type" — which is a reasonable explanation for why
  early observations _assumed_ "read-only switches are fine". **However, switching
  in genuine read-only mode was never actually verified**, and the user never
  claimed it was safe. Do not assert that read-only-mode switching is unaffected;
  the only established fact is: in edit mode, `dirty=true` always breaks and
  `dirty=false` never breaks (because no `window.confirm` → no WIN-BLUR).
- **No hidden iframe / second window stealing OS focus?** A renderer-side
  `[focus-diag]` probe confirmed `top === self`, `parent === self`,
  `window.length === 0`, and zero iframes — a single window with no parent frame
  and no iframes. This ruled out "a hidden iframe or a second window grabbed the
  OS focus" as a cause.
- **The "confirm causes WIN-BLUR" conclusion took three rounds to nail, and
  was nearly dismissed on incomplete evidence.** Round 5 (3.5e) used a `caller`
  stack probe + user screenshot to pin `Sidebar.handleSelectDoc`'s `window.confirm`
  as the root-cause _direction_. Round 7 (3.5f) proved the dialog does **not**
  steal focus _while open_ (TL#20-21: `hasFocus=true` before and after), and the
  WIN-BLUR had not yet been captured in the logs — so the mechanism was briefly
  treated as "just an unavoidable precursor" rather than the trigger. Only round
  12 (3.5i) reinstated it as the confirmed mechanism by proving the blur fires on
  _close_ (`logs_3.5i-A_dirty_true.log` TL#22, `relatedTarget=null`, _before_ the
  re-render; TL#23 shows `hasFocus` was already false before `setActiveDocumentId`
  ran). The takeaway: a hypothesis can be right about the cause yet be temporarily
  downgraded on incomplete evidence — keep the probe until the mechanism is
  empirically nailed.
- **Dirty vs clean two-path comparison (the decisive contrast).** The two paths
  are identical except for the confirm. Side-by-side keyframes:

  | Stage                                       | clean (`dirty=false`, no confirm)        | dirty (`dirty=true`, confirm shown)                                 |
  | ------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------- |
  | `CONFIRM`                                   | — (not shown)                            | before/after `hasFocus=true` (dialog open does **not** steal focus) |
  | `DOC-SWITCH#1`                              | `activeEl=BODY`, `hasFocus=true`         | `activeEl=BODY`, `hasFocus=true`                                    |
  | `EDIT-EFFECT-START` (`editable` true→false) | outer `document.hasFocus()=**true**`     | outer `document.hasFocus()=**false**` ⭐                            |
  | after `POINTERDOWN`→Edit                    | auto-recovers, `hasFocus=true`, typeable | stuck `hasFocus=false`, **cannot type**                             |

  Both paths flip `view.hasFocus` to `false` at `EDIT-EFFECT-START` (expected in
  read-only mode) — only the _outer_ `document.hasFocus()` differs, and the only
  difference between the paths is the `window.confirm` (hence the WIN-BLUR). This
  is the cleanest demonstration that the OS blur — not the re-render — is the
  cause.

- **The confirm dialog "steals focus while open"?** Instrumentation showed
  `document.hasFocus()` was `true` both before and after the dialog was shown.
  The dialog itself does _not_ steal focus; only its **closing** fires the OS
  blur. This subtlety delayed the diagnosis.

- **Optional closed-loop validation (3.5i-B, recommended but non-essential).**
  To make the "confirm → WIN-BLUR → stuck focus" chain a fully closed loop,
  one can temporarily comment out the confirm branch in `Sidebar.handleSelectDoc`
  to create a state where `dirty=true` but **no confirm is shown**, then repeat
  the dirty-path save-and-switch. The expected result: without the confirm, no
  WIN-BLUR is produced and typing is **not** broken — isolating the confirm as
  the sole trigger. This contrast was noted in the original investigation as a
  recommended extra confirmation; it was not strictly required because rounds
  3.5e/3.5f/3.5i had already nailed the mechanism by other instrumentation. It
  is listed here so a future reader can run it if they want 100% closure.

### 4.3 The most misleading wrong theory (and why it was rejected)

An early compelling theory was that `window.confirm` _blocks the event loop_, so
the post-confirm `setActiveDocumentId` re-render commits in an abnormal timing
window that "pins" `document.hasFocus()` false (a React batching problem).

This was disproven by deferring `setActiveDocumentId` with `setTimeout(…, 0)`
so the re-render happened a macrotask later. `document.hasFocus()` was already
`false` **before** the re-render ran — at the exact moment the confirm closed.
The real trigger is the OS `blur` event on confirm close, **not** React
batching timing.

### 4.4 `ipcMain.handle` duplicate registration

When implementing the fix, registering the `dialog:confirm` handler more than
once throws at startup (`Attempted to register a second handler for
'dialog:confirm'`). Ensure exactly one registration. In practice this error was
hit because the `ipcMain.handle('dialog:confirm', ...)` block was accidentally
written **three times** across multiple edit passes of `electron/main/index.ts`
(the editor appended a fresh copy on each edit rather than replacing the old
one). The symptom was a hard crash on launch with that exact error message; the
fix was simply to delete the duplicate copies until only one registration
remained.

### 4.5 Lessons

- **Don't equate a successful manual Console experiment with a successful
  in-code call.** A manually typed `webContents.focus()` may run when the window
  is _not_ foreground (so it emits a real focus event), whereas the automatic
  in-app call runs when the window _is_ foreground (so it's a no-op).
- **Don't guess "which DOM operation clears focus" and blindly apply
  subtractions.** First get a deterministic log of _when_ focus flips; here the
  flip happened at confirm-close, not at any re-render.
- **Once an OS-modal dialog has blurred the window, you cannot "focus your way
  back" from inside the app.** Fix the cause (don't trigger the blur), don't
  treat the symptom.
- **In Electron, `mainWindow.isFocused()` and `document.hasFocus()` can
  disagree.** The window can report focused while the _document_ flag is false.
  Don't trust the main-process flag alone. In this investigation the main-process
  probe reported `isFocused=true`, `blurEvents=0` for the whole run while the
  renderer _did_ lose OS focus and a real WIN-BLUR fired — the flag almost
  misled us into dismissing the OS-blur direction entirely. Always corroborate
  with renderer-side `document.hasFocus()` / `window` `blur` events.
- **On seeing a WIN-BLUR, verify the trigger before hunting components.** The
  WIN-BLUR carries `relatedTarget === null`, meaning focus was returned to
  _nothing_ in the app — the window itself lost OS focus, not a sibling component
  grabbed it. Component-level suspects (Radix `Tooltip`/`Popover`, the title
  `<input autoFocus>`, the formatting toolbar) were ruled out because no blur
  fired on them and `activeElement` was already `BODY` _before_ the switch.
  Confirm "is this the dialog itself closing?" before attributing it to a UI
  component.
- **A correct hypothesis can be rejected on incomplete evidence — keep the probe
  until the mechanism is nailed.** The `window.confirm` root cause was pinned as
  a _direction_ in round 5 (3.5e, via a `caller` stack probe + screenshot), briefly
  downgraded to "mere precursor" in round 7 (3.5f, because the dialog did not steal
  focus while open and the WIN-BLUR had not yet been captured), then reinstated as
  the confirmed _mechanism_ in round 12 (3.5i, which proved the blur fires on
  _close_). Incomplete logs almost killed the right answer.
- **"Does not steal focus while open" is NOT "is innocent".** This is the most
  specific trap of this bug. Round 7 (3.5f, `TL#20-21`) proved `document.hasFocus()`
  was `true` _both before and after_ the dialog was shown, so the dialog does not
  steal focus _while open_ — but it still fires a real OS `blur` on **close**
  (`TL#22`, `relatedTarget=null`). Do not conclude "confirm is just a harmless
  prerequisite" from the "open-doesn't-steal" fact alone; verify the _close_
  behavior too. Conversely, do not over-correct and assume "prerequisite ⇒ not the
  root cause" — a prerequisite can still be the exact trigger (here, the confirm
  _is_ the root cause because of what it does on close).

### 4.6 Hard纪律 (do-not-relapse list)

These were the points most likely to be re-litigated after the root cause was
found. Recorded explicitly so a future session does not walk back into a dead end:

- **Do not re-introduce any `focus()` / IPC focus / `executeJavaScript('window.focus()')`
  recovery route.** All four variants (renderer `view.focus()` /
  `contentDOM.focus()` / `window.focus()`, main-process `webContents.focus()`,
  main-process `executeJavaScript('window.focus()')`) are proven no-ops when the
  window is already foreground (§6 of the original log, `TL#31/38/40/42-43/48-49`).
  They treat the symptom, not the cause.
- **Do not rephrase the cause as "confirm blocked the event loop and broke React
  batching."** That mechanism was **disproven** by round 12 (3.5i): deferring
  `setActiveDocumentId` via `setTimeout(…, 0)` showed `document.hasFocus()` was
  already `false` _before_ the re-render ran (the `WIN-BLUR` fired on confirm
  close). The correct phrasing is: "confirm closes → OS-level `WIN-BLUR` → window
  loses OS focus → `document.hasFocus()` stuck false." Always use the
  close-triggers-blur wording.
- **The six `window.confirm` call sites share one root cause.** Only
  `Sidebar.handleSelectDoc`'s dirty-path confirm is on the _reproduction_ path
  (the actual trigger). The other five (`Sidebar` close-workspace button,
  `App.tryCloseWorkspace`, `App` close-file menu, `App.handleDrop`,
  `EditorPane.handleClose`) are _same-root risk points_ — each contains a native
  `window.confirm` that would fire the identical `WIN-BLUR`. Fix B replaced all
  six so the whole defect class is eliminated, not just the repro site.

---

## 5. General rule for Electron apps

> **Do not use `window.confirm` / `alert` / `prompt` on critical UI paths in a
> desktop app.** They are OS-modal and, on closing, fire a real `window` `blur`
> that Electron does not automatically undo — leaving `document.hasFocus()`
> stuck `false` and silently breaking editable areas (CodeMirror, contenteditable,
> `<input>`).
>
> Replace them with an in-app modal component (non-OS-modal, focus stays in the
> window) or the main-process `dialog.showMessageBox` / `dialog.showOpenDialog`
> etc. (app-modal, Electron returns focus on close).

This is the only robust class of fix. Anything that tries to "steal focus back"
after the OS blur is treating the symptom and will fail intermittently.

# Copilot Autonomous Loop v0.3

A VS Code extension for autonomous task planning, execution, and monitoring. Provides a unified dashboard for managing tasks, projects, quality metrics, and inbox across multiple work streams. Self-planning engine, workspace audit, drag-drop task management, and LM-powered decision support.

## Key Features (v0.3)

✅ **Workspace Audit Bootstrap** — Auto-discovers projects from workspace folders on startup, maps structure, and seeds strategic tasks
✅ **Validation & Health Checks** — One-click validation button to assess task completeness, quality metrics, and identify missing fields
✅ **Drag-and-Drop Task Management** — Reorder tasks across status columns (Active → Pending → Blocked → On-Hold → Done) with persistent manual lock
✅ **Rich Task Editor** — Edit description, status, priority, nextAction, notes, attachments, and manual order; lock tasks from agent changes
✅ **Goal-First Self Planning** — Seeds a starter backlog and builds execution order based on project discovery
✅ **Autonomous Ordering Engine** — Detects dependencies and maintains a ranked focus queue
✅ **LM API Integration** — Direct Copilot API calls with timeout and fallback
✅ **Automated State Updates** — Parses agent output blocks; applies task completions, new tasks, memory updates
✅ **Dual Triggers** — Interval-based + daily anchor times (configurable)
✅ **Autonomous Task Pipeline** — Auto-generates pending tasks from project next actions
✅ **Blocked Task Workflow** — Supports blocked status, blocker tracking, and dashboard unblock actions
✅ **Structured Blocker Decisions** — Track blocker status, options, decisions, and next steps
✅ **Rich Dashboard** — 9 tabs: Tasks, Projects, History, Quality, Inbox, Blockers, Last LM Response, Settings, State JSON
✅ **Quality KPIs** — Planning quality, traceability, stability, and consistency scores with history
✅ **Knowledge Inbox** — Auto-import & auto-tag documents (.txt, .md, .json, .html) with generic topics
✅ **Flexible Configuration** — All settings editable in Settings tab (timing, model, prompts, behavior)
✅ **Fallback UI** — Opens Copilot Chat if LM unavailable
✅ **State Backup** — Dated backups before each cycle
✅ **Status Bar** — Real-time agent state (Idle / Running / Working)
✅ **Onload Activation** — Workspace audit on startup

## Architecture

```
Scheduler ──┬─→ Load state.json (tasks, projects, inbox, memory)
            │
            ├─→ LM API Call (system + user prompts)
            │   └─ Timeout: 2 min | Fallback: Copilot Chat UI
            │
            ├─→ Parse <agent-update> block
            │   ├─ Mark tasks done
            │   ├─ Update nextActions
            │   ├─ Add new tasks
            │   ├─ Record blockers/decisions
            │   └─ Update memory
            │
            └─→ Save state.json + dated backup + cycle record
```

## Setup (v0.2)

### Requirements

- **VS Code 1.90+** (LM API available from 1.90+)
- **GitHub Copilot Chat** extension
- **Node.js 16+**

### Install

```bash
git clone https://github.com/kamishakerian-alt/scheduled-copilot-agent.git
cd scheduled-copilot-agent
npm install
npm run compile
```

### Launch

1. Open in VS Code Insiders
2. Press **F5** to start Extension Host
3. Command Palette → **Scheduled Copilot Agent: Open Dashboard**

## Configuration

### Dashboard → Settings tab (easiest)

Or edit `.vscode/settings.json`:

```json
{
  "scheduledCopilotAgent.stateFilePath": "state.json",
  "scheduledCopilotAgent.importFolderPath": "imports",
  "scheduledCopilotAgent.intervalSeconds": 60,
  "scheduledCopilotAgent.uiContinuousDelayMs": 2500,
  "scheduledCopilotAgent.dailyTriggerTimes": ["09:00", "21:00"],
  "scheduledCopilotAgent.executionMode": "copilot-ui",
  "scheduledCopilotAgent.autonomousExecutionMode": "continuous",
  "scheduledCopilotAgent.requireManualStart": true,
  "scheduledCopilotAgent.modelFamily": "gpt-4o",
  "scheduledCopilotAgent.launchOnActivate": false,
  "scheduledCopilotAgent.backupStateOnCycle": true,
  "scheduledCopilotAgent.promptTemplate": "Current agent state:\n\n${state}\n\nContinue work on highest priority active task.",
  "scheduledCopilotAgent.systemPrompt": ""
}
```

- **dailyTriggerTimes**: Times in HH:MM (Europe/Berlin timezone)
- **systemPrompt**: Leave blank for built-in Kami context
- **executionMode (default)**: `copilot-ui`
- **autonomousExecutionMode (default)**: `continuous`
- **requireManualStart (default)**: `true` (no autonomous run on editor startup)
- **uiContinuousDelayMs**: delay between continuous UI loops to keep Copilot chat responsive

## Built-in System Prompt

Includes:
- **Context**: Kami at Bosch, freigestellt until 2027, possible Abfindung ~240k EUR
- **Career paths**: DAFF/TMC Netherlands, SecureKern, company acquisition, wellness/SaaS
- **Daily anchors**: 09:00 and 21:00 Europe/Berlin
- **Output**: Requires `<agent-update>{ … }</agent-update>` JSON block

## Expected LM Response Format

```
<agent-update>
{
  "completedTaskIds": ["task-001"],
  "taskUpdates": [
    {"id": "task-002", "nextAction": "New action", "status": "active"}
  ],
  "newTasks": [
    {"id": "task-NEW", "description": "...", "priority": "top", "status": "active", "nextAction": "..."}
  ],
  "memoryUpdate": {
    "currentFocus": "task-002",
    "keyDecisions": ["Decision text"]
  },
  "cycleNote": "One-line summary",
  "blockers": [
    {"id": "blocker-1", "description": "Awaiting HR decision", "type": "decision"}
  ]
}
</agent-update>
```

All fields optional; block must be present.

## Dashboard Tabs

| Tab | Purpose |
|-----|---------|
| **Tasks** | Kanban board: Active / Pending / Done; add tasks, mark complete |
| **Projects** | DAFF, Bosch, SecureKern, side projects; view status & next actions |
| **History** | Last 60 cycles: timestamp, outcome, duration, note |
| **Quality** | KPI dashboard: planning quality, traceability, stability, consistency + trend |
| **Inbox** | Auto-tagged imported docs (.txt, .md, .json, .html) |
| **Blockers** | Strategic decisions & blockers logged by agent |
| **Last LM Response** | Full LM response text for inspection |
| **Settings** | All config options: timing, model, prompts, backups |
| **State JSON** | Raw state.json editor + save/reload |

## Commands

- `scheduledCopilotAgent.start` → Start scheduler
- `scheduledCopilotAgent.stop` → Stop scheduler
- `scheduledCopilotAgent.triggerNow` → Run one cycle now
- `scheduledCopilotAgent.openDashboard` → Open dashboard
- `scheduledCopilotAgent.importKnowledgeInbox` → Import inbox files
- `scheduledCopilotAgent.backupState` → Manual backup

## Status Bar

- `$(circle-outline) Agent Idle` — not running
- `$(radio-tower) Agent Running` — active, waiting for next cycle
- `$(sync~spin) Agent Working…` — cycle in progress (click for dashboard)

## State Schema

```json
{
  "schemaVersion": 2,
  "tasks": [{ "id", "description", "status": "active|pending|blocked|done", "priority", "nextAction", ... }],
  "projects": [{ "id", "name", "status", "summary", "nextActions", ... }],
  "knowledgeInbox": [{ "id", "title", "content", "tags", "importedAt", ... }],
  "memory": {
    "currentFocus": "task-id",
    "keyDecisions": [],
    "blockers": [{ "id", "description", "type", "status", "options", "decision", "nextStep", "createdAt", "updatedAt" }],
    "lastCycleAt": "2026-05-20T...",
    "totalCyclesRun": 42
  },
  "qualityGoals": { "planningQualityMin": 85, "traceabilityMin": 90, "stabilityMin": 95 },
  "latestQuality": { "planningQualityScore": 92, "traceabilityScore": 95, "stabilityScore": 97, "stateConsistencyScore": 100, ... },
  "qualityHistory": [{ "timestamp", "planningQualityScore", "traceabilityScore", "stabilityScore", "stateConsistencyScore", ... }],
  "cycleHistory": [{ "timestamp", "outcome", "note", "duration" }]
}
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| LM API not working | Ensure VS Code 1.90+; check Copilot Chat installed |
| State not saving | Check file permissions; verify path is correct |
| Tasks not showing | Refresh dashboard; check state.json is valid JSON |
| Fallback to Copilot UI | LM unavailable; manual review in chat interface |

## Strategic Log

- File: `STRATEGIC_BLOCKERS.md`
- Updated automatically when LM returns blockers or `memoryUpdate.keyDecisions`
- Purpose: keep strategic blockers and high-level decisions traceable across autonomous runs

## Development

```bash
npm run watch       # Auto-recompile on changes
npm run compile     # One-time compile
F5                  # Launch extension host
```

## License

MIT — Built for Kami's autonomous life/work orchestration.

---

**v0.2 Changelog:**
- ✨ LM API integration (direct Copilot calls, no UI)
- ✨ Automated state parsing & updates
- ✨ Daily trigger times (09:00 / 21:00 Berlin)
- ✨ Rich dashboard with project view, blocker tracking, history
- ✨ Built-in Kami system prompt
- 🐛 Fixed: onStartupFinished activation

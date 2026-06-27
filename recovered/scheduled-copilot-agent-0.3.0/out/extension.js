"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
// Timer handles are environment-agnostic via ReturnType.
let intervalHandle;
let timeCheckHandle;
// Define missing variables
let statusBarItem;
let dashboardPanel;
const PRIORITY_ORDER = {
    top: 3,
    high: 2,
    normal: 1,
};
const STRATEGIC_LOG_FILE = "STRATEGIC_BLOCKERS.md";
const DEFAULT_QUALITY_GOALS = {
    planningQualityMin: 85,
    traceabilityMin: 90,
    stabilityMin: 95,
};
// ─── Module State ─────────────────────────────────────────────────────────────
let isSchedulerRunning = false;
let isExecuting = false;
let schedulerCycleCount = 0;
const _lastDailyTrigger = {};
const SYSTEM_PROMPT_DEFAULT = `You are an autonomous intelligent agent designed to help organize, plan, and execute work across multiple projects and priorities.

ROLE:
1. Analyze the current task state, projects, inbox, and blockers
2. Identify and prioritize the highest-impact actionable item
3. Generate concrete output: plans, analyses, action lists, decision frameworks
4. Complete as much as possible end-to-end in the same cycle before stopping
5. Record dependencies, risks, and decisions transparently
6. Propose updates to task state and memory

HARD RULES:
- Never modify tasks with status "done"
- Focus work on tasks with status "active" or "pending"
- Mark tasks as "blocked" if external input is needed; continue with next-best item
- Always respect user preferences defined in Settings
- When context is incomplete, ask for clarification or defer to next cycle

OUTPUT FORMAT — always end your response with this exact XML block (valid JSON inside):
<agent-update>
{
  "completedTaskIds": [],
  "taskUpdates": [{"id": "task-id", "nextAction": "updated next action", "status": "active"}],
  "newTasks": [{"id": "task-NEW", "description": "...", "priority": "high", "status": "active", "nextAction": "..."}],
  "memoryUpdate": {"currentFocus": "task-id", "keyDecisions": []},
  "cycleNote": "One-line summary of what was done this cycle",
  "blockers": [{"id": "blocker-1", "description": "Decision needed: ...", "type": "decision"}],
  "progressPercent": 0,
  "objectiveReached": false,
  "objectiveSummary": "Optional: why the objective is now complete"
}
</agent-update>

Always include the block even if arrays are empty.

AUTONOMY RULES:
- You can define the next task yourself using newTasks/taskUpdates.
- Default behavior is finish-max: complete the full scope of the current objective in one cycle whenever feasible.
- Avoid "micro-step" updates unless continuation is genuinely blocked.
- If blocked on one task, document blocker and continue with next planned activity in the same cycle.
- If active tasks are low, create concrete follow-up tasks from project next actions to keep execution moving.
- If the objective is fully reached, set objectiveReached=true and provide objectiveSummary.`;
// ─── Activation ───────────────────────────────────────────────────────────────
async function activate(context) {
    // Status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = "scheduledCopilotAgent.openDashboard";
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    updateStatusBar();
    if (context.extensionMode === vscode.ExtensionMode.Development) {
        vscode.window.setStatusBarMessage("Scheduled Copilot Agent activated (Dev Host).", 4000);
    }
    // Register commands
    context.subscriptions.push(vscode.commands.registerCommand("scheduledCopilotAgent.start", async () => {
        await startScheduler();
    }), vscode.commands.registerCommand("scheduledCopilotAgent.stop", () => {
        stopScheduler();
    }), vscode.commands.registerCommand("scheduledCopilotAgent.triggerNow", async () => {
        await executeCycle();
    }), vscode.commands.registerCommand("scheduledCopilotAgent.openDashboard", async () => {
        await openDashboard(context);
    }), vscode.commands.registerCommand("scheduledCopilotAgent.importKnowledgeInbox", async () => {
        const count = await importKnowledgeInbox();
        vscode.window.showInformationMessage(`Imported ${count} knowledge inbox item(s).`);
    }), vscode.commands.registerCommand("scheduledCopilotAgent.backupState", async () => {
        const config = getConfig();
        const statePath = resolveStatePath(config);
        await backupState(statePath);
        vscode.window.showInformationMessage("State backed up.");
    }));
    // React to settings changes
    vscode.workspace.onDidChangeConfiguration(async (event) => {
        if (event.affectsConfiguration("scheduledCopilotAgent")) {
            if (isSchedulerRunning) {
                stopScheduler();
                await startScheduler();
            }
        }
    }, undefined, context.subscriptions);
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
        try {
            const cfg = getConfig();
            const statePath = resolveStatePath(cfg);
            const result = await ensureWorkspaceAuditState(statePath, {
                reason: "workspace-folders-change",
            });
            if (result.bootstrapped) {
                vscode.window.setStatusBarMessage("Workspace audit refreshed after folder change.", 3000);
                if (dashboardPanel) {
                    await sendDashboardData(dashboardPanel);
                    await sendDashboardMessage(dashboardPanel, `${result.message}\n${result.validation}`);
                }
            }
        }
        catch {
            // Ignore workspace-change bootstrap errors to keep extension responsive.
        }
    }, undefined, context.subscriptions);
    const initialConfig = getConfig();
    try {
        const statePath = resolveStatePath(initialConfig);
        const startupAudit = await ensureWorkspaceAuditState(statePath, {
            reason: "extension-activate",
        });
        if (startupAudit.bootstrapped) {
            vscode.window.setStatusBarMessage("Workspace audit initialized on startup.", 3500);
        }
    }
    catch {
        // Non-fatal: startup audit should not block activation.
    }
    if (!initialConfig.requireManualStart && initialConfig.launchOnActivate) {
        await startScheduler();
    }
    else if (initialConfig.requireManualStart) {
        vscode.window.setStatusBarMessage("Copilot Autonomous Loop loaded (manual start mode).", 3500);
    }
}
function deactivate() {
    stopScheduler();
    statusBarItem?.dispose();
}
// ─── Config ───────────────────────────────────────────────────────────────────
function getConfig() {
    const config = vscode.workspace.getConfiguration("scheduledCopilotAgent");
    const legacyIntervalMinutes = config.get("intervalMinutes", 60);
    const configuredIntervalSeconds = config.get("intervalSeconds", 0);
    const intervalSeconds = Math.max(1, configuredIntervalSeconds && configuredIntervalSeconds > 0
        ? configuredIntervalSeconds
        : Math.round(legacyIntervalMinutes * 60));
    return {
        stateFilePath: config.get("stateFilePath", "state.json"),
        importFolderPath: config.get("importFolderPath", "imports"),
        intervalSeconds,
        uiContinuousDelayMs: Math.max(0, config.get("uiContinuousDelayMs", 2500)),
        copilotOpenCommand: config.get("copilotOpenCommand", "workbench.action.chat.open"),
        copilotOpenArgs: config.get("copilotOpenArgs", null),
        requireManualStart: config.get("requireManualStart", true),
        promptTemplate: config.get("promptTemplate", "Current agent state:\n\n${state}\n\nReview the state and continue work on the highest priority active task."),
        launchOnActivate: config.get("launchOnActivate", false),
        dailyTriggerTimes: config.get("dailyTriggerTimes", []),
        modelFamily: config.get("modelFamily", "auto"),
        systemPrompt: config.get("systemPrompt", ""),
        backupStateOnCycle: config.get("backupStateOnCycle", true),
        autoStopOnObjectiveReached: config.get("autoStopOnObjectiveReached", true),
        maxIterations: Math.max(0, config.get("maxIterations", 0)),
        autonomousExecutionMode: config.get("autonomousExecutionMode", "continuous"),
        completionThresholdPercent: Math.min(100, Math.max(1, config.get("completionThresholdPercent", 90))),
        maxAutonomousIterationsPerRun: Math.max(1, config.get("maxAutonomousIterationsPerRun", 100)),
        executionMode: config.get("executionMode", "copilot-ui"),
    };
}
async function getAvailableCopilotModelFamilies() {
    const fallback = [
        "auto",
        "gpt-4o",
        "gpt-4.1",
        "gpt-4",
        "o3",
        "claude-sonnet",
    ];
    try {
        const lmApi = vscode.lm;
        if (!lmApi?.selectChatModels) {
            return fallback;
        }
        const models = await lmApi.selectChatModels({ vendor: "copilot" });
        const families = new Set(["auto"]);
        for (const model of models) {
            const m = model;
            const family = (m.family || "").trim();
            if (family) {
                families.add(family);
            }
        }
        // Ensure fallback entries are still selectable even if API metadata is sparse.
        for (const fm of fallback) {
            families.add(fm);
        }
        return Array.from(families);
    }
    catch {
        return fallback;
    }
}
// ─── Status Bar ───────────────────────────────────────────────────────────────
function updateStatusBar() {
    if (!statusBarItem) {
        return;
    }
    if (isExecuting) {
        statusBarItem.text = "$(sync~spin) Agent Working…";
        statusBarItem.tooltip =
            "Agent is executing a cycle — click to open dashboard";
    }
    else if (isSchedulerRunning) {
        statusBarItem.text = "$(radio-tower) Agent Running";
        statusBarItem.tooltip =
            "Scheduled Copilot Agent is running — click to open dashboard";
    }
    else {
        statusBarItem.text = "$(circle-outline) Agent Idle";
        statusBarItem.tooltip =
            "Scheduled Copilot Agent is idle — click to open dashboard";
    }
}
// ─── Scheduler ────────────────────────────────────────────────────────────────
async function startScheduler() {
    const config = getConfig();
    stopScheduler();
    isSchedulerRunning = true;
    schedulerCycleCount = 0;
    updateStatusBar();
    if (config.autonomousExecutionMode === "interval") {
        const ms = Math.max(1, config.intervalSeconds) * 1000;
        intervalHandle = setInterval(() => {
            void executeCycle();
        }, ms);
        if (config.dailyTriggerTimes.length > 0) {
            timeCheckHandle = setInterval(() => checkDailyTriggerTimes(config), 60000);
        }
        const timeInfo = config.dailyTriggerTimes.length > 0
            ? ` Daily triggers: ${config.dailyTriggerTimes.join(", ")} (Berlin).`
            : "";
        vscode.window.showInformationMessage(`Agent started (interval mode). Interval: ${config.intervalSeconds}s.${timeInfo}`);
    }
    else {
        vscode.window.showInformationMessage(`Agent started (continuous self-paced mode). Stops at ${config.completionThresholdPercent}%+ or objectiveReached=true.`);
    }
    await executeCycle();
}
function stopScheduler(reason) {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = undefined;
    }
    if (timeCheckHandle) {
        clearInterval(timeCheckHandle);
        timeCheckHandle = undefined;
    }
    if (isSchedulerRunning) {
        isSchedulerRunning = false;
        schedulerCycleCount = 0;
        updateStatusBar();
        vscode.window.showInformationMessage(reason ? `Agent stopped: ${reason}` : "Agent stopped.");
    }
}
function checkDailyTriggerTimes(config) {
    const now = new Date();
    const berlinHHMM = now.toLocaleTimeString("de-DE", {
        timeZone: "Europe/Berlin",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
    const todayKey = now.toISOString().slice(0, 10);
    for (const triggerTime of config.dailyTriggerTimes) {
        const key = `${todayKey}-${triggerTime}`;
        if (berlinHHMM === triggerTime && _lastDailyTrigger[triggerTime] !== key) {
            _lastDailyTrigger[triggerTime] = key;
            void executeCycle();
        }
    }
}
// ─── State Management ─────────────────────────────────────────────────────────
function resolveStatePath(config) {
    return resolveWorkspacePath(config.stateFilePath);
}
function resolveWorkspacePath(configuredPath) {
    if (path.isAbsolute(configuredPath)) {
        return configuredPath;
    }
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        throw new Error("Open a workspace folder before using the Scheduled Copilot Agent.");
    }
    return path.join(folders[0].uri.fsPath, configuredPath);
}
function normalizeBlocker(blocker, fallbackId) {
    const now = new Date().toISOString();
    const normalizedOptions = Array.isArray(blocker.options) && blocker.options.length > 0
        ? blocker.options
        : ["Option A: konservativ", "Option B: beschleunigen"];
    return {
        id: blocker.id || fallbackId,
        description: blocker.description || "Strategischer Blocker ohne Beschreibung.",
        type: blocker.type || "decision",
        severity: blocker.severity || "normal",
        status: blocker.status || "open",
        options: normalizedOptions,
        decision: blocker.decision || "pending decision",
        nextStep: blocker.nextStep ||
            "Expert decision required: choose one option and define next step.",
        relatedTaskId: blocker.relatedTaskId,
        createdAt: blocker.createdAt || now,
        updatedAt: blocker.updatedAt || now,
    };
}
function normalizeState(state) {
    const tasksInput = Array.isArray(state.tasks) ? state.tasks : [];
    const taskIdSet = new Set();
    const tasks = [];
    for (const task of tasksInput) {
        const id = task.id || `task-${Date.now()}-${tasks.length + 1}`;
        if (taskIdSet.has(id)) {
            continue;
        }
        taskIdSet.add(id);
        const status = [
            "active",
            "pending",
            "blocked",
            "on-hold",
            "deprecated",
            "irrelevant",
            "done",
        ].includes(task.status)
            ? task.status
            : "pending";
        const priority = ["top", "high", "normal"].includes(task.priority)
            ? task.priority
            : "normal";
        tasks.push({
            ...task,
            id,
            status,
            priority,
            attachments: Array.isArray(task.attachments)
                ? task.attachments.filter((v) => typeof v === "string" && v.trim())
                : [],
            notes: typeof task.notes === "string" ? task.notes : "",
            userModified: !!task.userModified,
            userModifiedAt: task.userModifiedAt,
            createdAt: task.createdAt || new Date().toISOString(),
            updatedAt: task.updatedAt || new Date().toISOString(),
            completedAt: status === "done"
                ? task.completedAt || new Date().toISOString()
                : undefined,
        });
    }
    const memory = (typeof state.memory === "object" && state.memory !== null
        ? { ...state.memory }
        : {});
    const blockerInput = Array.isArray(memory.blockers) ? memory.blockers : [];
    const blockerIdSet = new Set();
    const blockers = [];
    for (let i = 0; i < blockerInput.length; i += 1) {
        const normalized = normalizeBlocker(blockerInput[i], `blocker-${i + 1}`);
        if (blockerIdSet.has(normalized.id)) {
            continue;
        }
        blockerIdSet.add(normalized.id);
        blockers.push(normalized);
    }
    memory.blockers = blockers;
    const activeOrPending = tasks
        .filter((t) => t.status === "active" || t.status === "pending")
        .sort((a, b) => PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority]);
    if (!activeOrPending.find((t) => t.id === memory.currentFocus)) {
        memory.currentFocus = activeOrPending[0]?.id;
    }
    return {
        ...state,
        schemaVersion: 2,
        tasks,
        projects: Array.isArray(state.projects) ? state.projects : [],
        knowledgeInbox: Array.isArray(state.knowledgeInbox)
            ? state.knowledgeInbox
            : [],
        memory,
        cycleHistory: Array.isArray(state.cycleHistory) ? state.cycleHistory : [],
        lmResponses: Array.isArray(state.lmResponses) ? state.lmResponses : [],
        qualityGoals: {
            ...DEFAULT_QUALITY_GOALS,
            ...(state.qualityGoals || {}),
        },
        qualityHistory: Array.isArray(state.qualityHistory)
            ? state.qualityHistory
            : [],
    };
}
function computeQualitySnapshot(state) {
    const tasks = Array.isArray(state.tasks) ? state.tasks : [];
    const mem = (typeof state.memory === "object" && state.memory !== null
        ? state.memory
        : {});
    const blockers = Array.isArray(mem.blockers) ? mem.blockers : [];
    const actionable = tasks.filter((t) => t.status === "active" || t.status === "pending" || t.status === "blocked");
    const actionableWithNext = actionable.filter((t) => (t.nextAction || "").trim().length > 0).length;
    const planningQualityScore = actionable.length === 0
        ? 100
        : Math.round((actionableWithNext / actionable.length) * 100);
    const fullyDocumentedBlockers = blockers.filter((b) => !!b.status &&
        Array.isArray(b.options) &&
        b.options.length > 0 &&
        !!b.decision &&
        !!b.nextStep).length;
    const traceabilityScore = blockers.length === 0
        ? 100
        : Math.round((fullyDocumentedBlockers / blockers.length) * 100);
    const recentHistory = (Array.isArray(state.cycleHistory) ? state.cycleHistory : []).slice(-20);
    const errorCount = recentHistory.filter((h) => h.outcome === "error").length;
    const fallbackCount = recentHistory.filter((h) => h.outcome === "lm-fallback").length;
    const stabilityPenalty = Math.min(100, errorCount * 20 + fallbackCount * 8);
    const stabilityScore = 100 - stabilityPenalty;
    const uniqueTaskIds = new Set(tasks.map((t) => t.id));
    const uniqueBlockerIds = new Set(blockers.map((b) => b.id));
    const stateConsistencyScore = uniqueTaskIds.size === tasks.length &&
        uniqueBlockerIds.size === blockers.length
        ? 100
        : 70;
    return {
        timestamp: new Date().toISOString(),
        planningQualityScore,
        traceabilityScore,
        stabilityScore,
        stateConsistencyScore,
        openBlockers: blockers.filter((b) => b.status !== "resolved").length,
        blockersWithDecision: blockers.filter((b) => (b.decision || "").toLowerCase() !== "pending decision").length,
    };
}
async function loadState(filePath) {
    try {
        const contents = await fs.readFile(filePath, "utf8");
        return normalizeState(JSON.parse(contents));
    }
    catch {
        return normalizeState({
            schemaVersion: 2,
            tasks: [],
            projects: [],
            knowledgeInbox: [],
            memory: {},
            cycleHistory: [],
            lmResponses: [],
        });
    }
}
async function saveState(filePath, state) {
    await fs.writeFile(filePath, JSON.stringify(normalizeState(state), null, 2), "utf8");
}
async function backupState(filePath) {
    try {
        const contents = await fs.readFile(filePath, "utf8");
        const date = new Date().toISOString().slice(0, 10);
        const backupPath = filePath.replace(/\.json$/, `.backup.${date}.json`);
        await fs.writeFile(backupPath, contents, "utf8");
    }
    catch {
        // Backup failures are non-fatal
    }
}
// ─── Knowledge Inbox ──────────────────────────────────────────────────────────
async function importKnowledgeInbox() {
    const config = getConfig();
    const statePath = resolveStatePath(config);
    const importFolder = resolveWorkspacePath(config.importFolderPath);
    const state = await loadState(statePath);
    const existing = Array.isArray(state.knowledgeInbox)
        ? state.knowledgeInbox
        : [];
    const existingSources = new Set(existing.map((e) => e.source));
    let fileNames;
    try {
        fileNames = await fs.readdir(importFolder);
    }
    catch {
        throw new Error(`Import folder not found: ${importFolder}`);
    }
    const imported = [];
    for (const fileName of fileNames) {
        const ext = path.extname(fileName).toLowerCase();
        if (![".txt", ".md", ".json", ".html"].includes(ext)) {
            continue;
        }
        const filePath = path.join(importFolder, fileName);
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) {
            continue;
        }
        const source = path.relative(path.dirname(statePath), filePath);
        if (existingSources.has(source)) {
            continue;
        }
        const content = await fs.readFile(filePath, "utf8");
        imported.push({
            id: `inbox-${Date.now()}-${imported.length + 1}`,
            importedAt: new Date().toISOString(),
            source,
            title: path.basename(fileName, ext),
            content,
            tags: inferInboxTags(fileName, content),
        });
    }
    if (imported.length === 0) {
        return 0;
    }
    const mem = (typeof state.memory === "object" && state.memory !== null
        ? state.memory
        : {});
    await saveState(statePath, {
        ...state,
        knowledgeInbox: [...existing, ...imported],
        memory: { ...mem, lastKnowledgeImportAt: new Date().toISOString() },
    });
    return imported.length;
}
function inferInboxTags(fileName, content) {
    const h = `${fileName}\n${content}`.toLowerCase();
    const tags = new Set(["inbox"]);
    const lower = h.toLowerCase();
    // Document source tags
    if (lower.includes("grok"))
        tags.add("grok");
    if (lower.includes("onenote") || lower.includes("one note"))
        tags.add("notes");
    if (lower.includes("email") || lower.includes("mail"))
        tags.add("email");
    if (lower.includes("chat") || lower.includes("slack") || lower.includes("teams"))
        tags.add("chat");
    // Generic topic tags for document classification
    if (lower.includes("decision") || lower.includes("approval"))
        tags.add("decision");
    if (lower.includes("budget") || lower.includes("financial") || lower.includes("accounting"))
        tags.add("financial");
    if (lower.includes("health") || lower.includes("medical") || lower.includes("fitness"))
        tags.add("health");
    if (lower.includes("meeting") || lower.includes("sync") || lower.includes("standup"))
        tags.add("meeting");
    if (lower.includes("action") || lower.includes("todo") || lower.includes("checklist"))
        tags.add("action-item");
    if (lower.includes("reference") || lower.includes("documentation") || lower.includes("guide"))
        tags.add("reference");
    if (lower.includes("risk") || lower.includes("issue") || lower.includes("problem"))
        tags.add("risk");
    if (lower.includes("idea") || lower.includes("opportunity") || lower.includes("feature"))
        tags.add("idea");
    return [...tags];
}
function normalizeTextForDedupe(value) {
    return value.toLowerCase().replace(/\s+/g, " ").trim();
}
function slugify(value) {
    return (value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "task");
}
function autoPlanTasksFromProjects(state) {
    const tasks = Array.isArray(state.tasks) ? [...state.tasks] : [];
    const projects = Array.isArray(state.projects) ? state.projects : [];
    const mem = (typeof state.memory === "object" && state.memory !== null
        ? state.memory
        : {});
    const openTasks = tasks.filter((t) => t.status === "active" || t.status === "pending");
    let generated = [];
    if (openTasks.length < 3) {
        const existingSignals = new Set();
        for (const t of tasks) {
            existingSignals.add(normalizeTextForDedupe(`${t.projectId ?? ""} ${t.description}`));
            if (t.nextAction) {
                existingSignals.add(normalizeTextForDedupe(`${t.projectId ?? ""} ${t.nextAction}`));
            }
        }
        const needed = Math.max(0, 3 - openTasks.length);
        for (const p of projects) {
            if (generated.length >= needed) {
                break;
            }
            const nextActions = Array.isArray(p.nextActions) ? p.nextActions : [];
            for (const action of nextActions) {
                if (generated.length >= needed) {
                    break;
                }
                const signal = normalizeTextForDedupe(`${p.id} ${action}`);
                if (!signal || existingSignals.has(signal)) {
                    continue;
                }
                const idSuffix = slugify(`${p.id}-${action}`);
                generated.push({
                    id: `task-auto-${Date.now()}-${generated.length + 1}-${idSuffix}`,
                    projectId: p.id,
                    description: action,
                    status: "pending",
                    priority: p.status === "active" || p.status === "strategic"
                        ? "high"
                        : "normal",
                    nextAction: action,
                });
                existingSignals.add(signal);
            }
        }
        if (generated.length < needed) {
            const blockers = Array.isArray(mem.blockers) ? mem.blockers : [];
            for (const blocker of blockers) {
                if (generated.length >= needed) {
                    break;
                }
                const signal = normalizeTextForDedupe(`decision ${blocker.id} ${blocker.description}`);
                if (!signal || existingSignals.has(signal)) {
                    continue;
                }
                generated.push({
                    id: `task-decision-${Date.now()}-${generated.length + 1}-${slugify(blocker.id)}`,
                    description: `Resolve blocker: ${blocker.description}`,
                    status: "pending",
                    priority: blocker.severity === "critical" ? "top" : "high",
                    nextAction: blocker.relatedTaskId
                        ? `Decide unblock path for ${blocker.relatedTaskId} and define executable next step.`
                        : "Decide unblock path and define executable next step.",
                });
                existingSignals.add(signal);
            }
        }
    }
    if (tasks.length === 0 && generated.length === 0) {
        const goal = inferUltimateGoal(projects, []);
        const stamp = Date.now();
        generated.push({
            id: `task-goal-${stamp}-1`,
            description: `Define executable objective scope from goal: ${goal}`,
            status: "active",
            priority: "top",
            nextAction: "Write one-page objective, constraints, done criteria, and decision gates.",
            executionHint: "sequential",
        }, {
            id: `task-goal-${stamp}-2`,
            description: "Derive prioritized task backlog from objective and constraints.",
            status: "pending",
            priority: "high",
            nextAction: "Create 10-20 actionable tasks with owner, dependency, and success criteria.",
            executionHint: "sequential",
        }, {
            id: `task-goal-${stamp}-3`,
            description: "Execute first milestone and produce concrete artifacts.",
            status: "pending",
            priority: "high",
            nextAction: "Select highest-impact task and complete end-to-end where feasible.",
            executionHint: "parallel",
        });
    }
    const planned = applyAutonomousTaskPlanning([...tasks, ...generated], projects, mem);
    return {
        ...state,
        tasks: planned.tasks,
        memory: {
            ...mem,
            currentFocus: planned.currentFocus,
            executionPlan: planned.executionPlan,
        },
    };
}
function extractDependencyIds(task, knownIds) {
    const explicit = Array.isArray(task.dependsOn) ? task.dependsOn : [];
    const text = `${task.description || ""} ${task.nextAction || ""}`;
    const inferred = Array.from(text.matchAll(/(?:depends on|after|blocked by|nach)\s+([a-z0-9][a-z0-9\-_]+)/gi))
        .map((m) => (m[1] || "").trim())
        .filter((id) => id.length > 0);
    const merged = [...explicit, ...inferred]
        .map((id) => id.trim())
        .filter((id, i, arr) => id && arr.indexOf(id) === i && knownIds.has(id) && id !== task.id);
    return merged;
}
function inferExecutionHint(task) {
    if (task.executionHint === "sequential" ||
        task.executionHint === "parallel") {
        return task.executionHint;
    }
    const text = `${task.description || ""} ${task.nextAction || ""}`.toLowerCase();
    const sequentialSignals = [
        "approve",
        "antrag",
        "genehmigung",
        "verify",
        "legal",
        "compliance",
        "kredit",
        "bank",
    ];
    return sequentialSignals.some((s) => text.includes(s))
        ? "sequential"
        : "parallel";
}
function inferUltimateGoal(projects, tasks) {
    const activeProject = projects.find((p) => p.status === "active");
    if (activeProject?.summary && activeProject.summary.trim()) {
        return activeProject.summary.trim();
    }
    if (activeProject?.name) {
        return `Deliver project outcome for ${activeProject.name}.`;
    }
    const topTask = tasks.find((t) => t.status === "active" || t.status === "pending");
    return (topTask?.description?.trim() ||
        "Complete all active tasks with correct order and constraints.");
}
async function pathExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    }
    catch {
        return false;
    }
}
async function readSnippetIfExists(filePath, maxChars = 500) {
    if (!(await pathExists(filePath))) {
        return "";
    }
    try {
        const content = await fs.readFile(filePath, "utf8");
        return content.slice(0, maxChars).replace(/\s+/g, " ").trim();
    }
    catch {
        return "";
    }
}
function inferProjectTypeFromMarkers(markers) {
    if (markers.hasPackageJson) {
        return "node";
    }
    if (markers.hasPyProject || markers.hasRequirements) {
        return "python";
    }
    if (markers.hasReadme) {
        return "docs";
    }
    return "generic";
}
async function inferProjectsFromWorkspace() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return [];
    }
    const root = folders[0].uri.fsPath;
    const skipNames = new Set([
        ".git",
        ".vscode",
        "node_modules",
        "_Archived_Projects",
        "_deprecated",
        "_local_archive",
        "dist",
        "build",
        "out",
    ]);
    const candidates = [];
    candidates.push({ name: path.basename(root), absPath: root });
    let entries = [];
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    }
    catch {
        return [];
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        if (skipNames.has(entry.name) || entry.name.startsWith(".")) {
            continue;
        }
        candidates.push({ name: entry.name, absPath: path.join(root, entry.name) });
    }
    const projects = [];
    const seen = new Set();
    for (const candidate of candidates) {
        const hasPackageJson = await pathExists(path.join(candidate.absPath, "package.json"));
        const hasPyProject = await pathExists(path.join(candidate.absPath, "pyproject.toml"));
        const hasRequirements = await pathExists(path.join(candidate.absPath, "requirements.txt"));
        const hasReadme = await pathExists(path.join(candidate.absPath, "README.md"));
        const hasStrategy = await pathExists(path.join(candidate.absPath, "STRATEGY.md"));
        if (!hasPackageJson &&
            !hasPyProject &&
            !hasRequirements &&
            !hasReadme &&
            !hasStrategy) {
            continue;
        }
        const id = slugify(candidate.name || "project");
        if (seen.has(id)) {
            continue;
        }
        seen.add(id);
        const readmeSnippet = await readSnippetIfExists(path.join(candidate.absPath, "README.md"), 420);
        const strategySnippet = await readSnippetIfExists(path.join(candidate.absPath, "STRATEGY.md"), 320);
        const summary = strategySnippet ||
            readmeSnippet ||
            "Project found in workspace. Audit implementation and remaining gaps.";
        projects.push({
            id,
            name: candidate.name,
            status: "active",
            type: inferProjectTypeFromMarkers({
                hasPackageJson,
                hasPyProject,
                hasRequirements,
                hasReadme,
            }),
            summary,
            nextActions: [
                "Audit current implementation and intent against strategy.",
                "Identify missing features and incomplete end-to-end flows.",
                "Validate critical paths and fix blockers iteratively.",
            ],
            openQuestions: [
                "Which missing parts are strategic blockers that need human decision?",
            ],
        });
        if (projects.length >= 14) {
            break;
        }
    }
    return projects;
}
async function bootstrapWorkspaceAuditPlan(baseState) {
    const state = normalizeState(baseState);
    const inferredProjects = await inferProjectsFromWorkspace();
    const projects = inferredProjects.length > 0 ? inferredProjects : state.projects || [];
    const tasks = Array.isArray(state.tasks) ? [...state.tasks] : [];
    const canonicalSeed = [
        {
            description: "Audit project intent, architecture, and implementation status.",
            priority: "top",
            nextAction: "Check what is implemented, how it works, and where behavior differs from strategy.",
            executionHint: "sequential",
        },
        {
            description: "Define ultimate goal and completion criteria for 100% product readiness.",
            priority: "top",
            nextAction: "Write end-state criteria: fully functional, end-to-end validated, and benchmark-ready.",
            executionHint: "sequential",
        },
        {
            description: "Generate feature gap list and prioritized implementation plan.",
            priority: "high",
            nextAction: "Plan all missing features, sequence delivery, and keep iterating autonomously.",
            executionHint: "parallel",
        },
        {
            description: "Validate end-to-end flows, detect missing or broken parts, and continue execution.",
            priority: "high",
            nextAction: "Run audits/validation loops; document strategic blockers and continue with next activity.",
            executionHint: "parallel",
        },
    ];
    const existingSignals = new Set(tasks.map((t) => normalizeTextForDedupe(t.description || "")));
    const generated = [];
    const stamp = Date.now();
    for (let i = 0; i < canonicalSeed.length; i += 1) {
        const seed = canonicalSeed[i];
        const signal = normalizeTextForDedupe(seed.description);
        if (existingSignals.has(signal)) {
            continue;
        }
        generated.push({
            id: `task-audit-${stamp}-${i + 1}-${slugify(seed.description)}`,
            description: seed.description,
            status: i === 0 ? "active" : "pending",
            priority: seed.priority,
            nextAction: seed.nextAction,
            executionHint: seed.executionHint,
            userModified: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            attachments: [],
            notes: "",
        });
        existingSignals.add(signal);
    }
    const mergedState = {
        ...state,
        projects,
        tasks: [...tasks, ...generated],
        memory: {
            ...(state.memory || {}),
            auditDirective: "Check project intent and implementation, define ultimate goal, identify missing pieces, and iterate until product is fully functional. Do not create extra files just for information.",
            auditDirectiveUpdatedAt: new Date().toISOString(),
        },
    };
    const planned = autoPlanTasksFromProjects(mergedState);
    const goal = inferUltimateGoal(planned.projects || [], planned.tasks || []);
    const message = `Workspace audit initialized: ${projects.length} project(s) mapped, ${generated.length} strategic task(s) added. Ultimate goal: ${goal}`;
    return {
        state: planned,
        message,
    };
}
function buildStateValidationMessage(state) {
    const tasks = Array.isArray(state.tasks) ? state.tasks : [];
    const projects = Array.isArray(state.projects) ? state.projects : [];
    const open = tasks.filter((t) => t.status === "active" || t.status === "pending");
    const blocked = tasks.filter((t) => t.status === "blocked");
    const missingNextAction = open.filter((t) => !(t.nextAction || "").trim());
    const done = tasks.filter((t) => t.status === "done").length;
    const quality = computeQualitySnapshot(state);
    const lines = [
        `Validation: ${open.length} open, ${blocked.length} blocked, ${done} done tasks.`,
        `Quality scores -> Planning: ${quality.planningQualityScore}%, Traceability: ${quality.traceabilityScore}%, Stability: ${quality.stabilityScore}%.`,
        `Projects tracked: ${projects.length}.`,
    ];
    if (missingNextAction.length > 0) {
        lines.push(`Missing nextAction in ${missingNextAction.length} open task(s): ${missingNextAction
            .slice(0, 4)
            .map((t) => t.id)
            .join(", ")}`);
    }
    if (blocked.length > 0) {
        lines.push(`Blocked task ids: ${blocked
            .slice(0, 4)
            .map((t) => t.id)
            .join(", ")}`);
    }
    if (missingNextAction.length === 0 && blocked.length === 0) {
        lines.push("No immediate structural blockers found in state.");
    }
    return lines.join("\n");
}
function getWorkspaceAuditKey() {
    const folders = vscode.workspace.workspaceFolders || [];
    return folders
        .map((folder) => `${folder.name}:${folder.uri.fsPath}`)
        .sort((a, b) => a.localeCompare(b))
        .join("|")
        .toLowerCase();
}
async function ensureWorkspaceAuditState(statePath, options) {
    const reason = options?.reason || "manual";
    const force = !!options?.force;
    const loaded = await loadState(statePath);
    const state = normalizeState(loaded);
    const tasks = Array.isArray(state.tasks) ? state.tasks : [];
    const projects = Array.isArray(state.projects) ? state.projects : [];
    const memory = typeof state.memory === "object" && state.memory !== null
        ? state.memory
        : {};
    const workspaceAuditKey = getWorkspaceAuditKey();
    const previousAuditKey = typeof memory.workspaceAuditKey === "string"
        ? memory.workspaceAuditKey
        : "";
    const shouldBootstrap = force ||
        tasks.length === 0 ||
        projects.length === 0 ||
        previousAuditKey !== workspaceAuditKey;
    if (!shouldBootstrap) {
        return {
            state,
            bootstrapped: false,
            message: "Workspace audit already up to date.",
            validation: buildStateValidationMessage(state),
        };
    }
    const bootstrapped = await bootstrapWorkspaceAuditPlan(state);
    const validation = buildStateValidationMessage(bootstrapped.state);
    const mergedState = {
        ...bootstrapped.state,
        memory: {
            ...(bootstrapped.state.memory || {}),
            workspaceAuditKey,
            workspaceAuditReason: reason,
            workspaceAuditUpdatedAt: new Date().toISOString(),
            uiContextBootstrapped: true,
            lastValidationReport: validation,
            lastValidationReportAt: new Date().toISOString(),
        },
    };
    await saveState(statePath, mergedState);
    return {
        state: mergedState,
        bootstrapped: true,
        message: bootstrapped.message,
        validation,
    };
}
function applyAutonomousTaskPlanning(inputTasks, projects, memory) {
    const knownIds = new Set(inputTasks.map((t) => t.id));
    const doneIds = new Set(inputTasks.filter((t) => t.status === "done").map((t) => t.id));
    const normalized = inputTasks.map((task) => {
        const dependsOn = extractDependencyIds(task, knownIds);
        const dependencyBlocked = dependsOn.some((dep) => !doneIds.has(dep));
        const executionHint = inferExecutionHint(task);
        const userLocked = !!task.userModified;
        let status = task.status;
        if (!userLocked &&
            (status === "active" || status === "pending") &&
            dependencyBlocked) {
            status = "pending";
        }
        const project = projects.find((p) => p.id === task.projectId);
        const projectBoost = project?.status === "active" ? 0.3 : 0;
        const hasNextActionBoost = task.nextAction && task.nextAction.trim().length > 0 ? 0.2 : 0;
        const hintBoost = executionHint === "sequential" ? 0.15 : 0;
        const depPenalty = dependencyBlocked ? -10 : 0;
        const statusBoost = status === "active"
            ? 3
            : status === "pending"
                ? 1
                : status === "blocked"
                    ? -2
                    : -20;
        const score = PRIORITY_ORDER[task.priority] +
            statusBoost +
            projectBoost +
            hasNextActionBoost +
            hintBoost +
            depPenalty +
            (userLocked ? -1 : 0);
        return {
            ...task,
            status,
            dependsOn,
            executionHint,
            userLocked,
            _score: score,
            _dependencyBlocked: dependencyBlocked,
        };
    });
    const userOrdered = normalized
        .filter((t) => (t.status === "active" || t.status === "pending") &&
        t.userLocked &&
        typeof t.manualOrder === "number")
        .sort((a, b) => (a.manualOrder || 0) - (b.manualOrder || 0));
    const actionableSorted = normalized
        .filter((t) => t.status === "active" || t.status === "pending")
        .filter((t) => !userOrdered.find((u) => u.id === t.id))
        .sort((a, b) => b._score - a._score);
    const done = normalized
        .filter((t) => t.status === "done")
        .sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""));
    const blocked = normalized.filter((t) => t.status === "blocked");
    const parked = normalized.filter((t) => t.status === "on-hold" ||
        t.status === "deprecated" ||
        t.status === "irrelevant");
    const mergedActionable = [...userOrdered, ...actionableSorted];
    const orderedActionable = mergedActionable.map((task, idx) => ({
        ...task,
        order: idx + 1,
        manualOrder: task.userLocked && typeof task.manualOrder === "number"
            ? task.manualOrder
            : task.manualOrder,
    }));
    const currentFocus = orderedActionable[0]?.id || memory.currentFocus;
    const ultimateGoal = inferUltimateGoal(projects, orderedActionable);
    const executionPlan = {
        generatedAt: new Date().toISOString(),
        ultimateGoal,
        orderedTaskIds: orderedActionable.map((t) => t.id),
        sequentialTaskIds: orderedActionable
            .filter((t) => t.executionHint === "sequential")
            .map((t) => t.id),
        parallelTaskIds: orderedActionable
            .filter((t) => t.executionHint === "parallel" && !t._dependencyBlocked)
            .map((t) => t.id),
        blockedByDependencyTaskIds: orderedActionable
            .filter((t) => t._dependencyBlocked)
            .map((t) => t.id),
    };
    const tasks = [...orderedActionable, ...blocked, ...parked, ...done].map(({ _score, _dependencyBlocked, ...rest }) => rest);
    return {
        tasks,
        currentFocus,
        executionPlan,
    };
}
async function appendStrategicLog(statePath, cycleTimestamp, update) {
    const blockers = Array.isArray(update.blockers) ? update.blockers : [];
    const keyDecisions = Array.isArray(update.memoryUpdate?.keyDecisions)
        ? update.memoryUpdate?.keyDecisions
        : [];
    if (blockers.length === 0 && keyDecisions.length === 0) {
        return;
    }
    const logPath = path.join(path.dirname(statePath), STRATEGIC_LOG_FILE);
    const lines = [];
    lines.push(`## ${cycleTimestamp}`);
    if (keyDecisions.length > 0) {
        lines.push("");
        lines.push("### Strategic Decisions");
        for (const decision of keyDecisions) {
            lines.push(`- ${decision}`);
        }
    }
    if (blockers.length > 0) {
        lines.push("");
        lines.push("### Blockers");
        for (const blocker of blockers) {
            const sev = blocker.severity ? ` [${blocker.severity}]` : "";
            const rel = blocker.relatedTaskId
                ? ` (task: ${blocker.relatedTaskId})`
                : "";
            lines.push(`- ${blocker.type}${sev}: ${blocker.description}${rel}`);
            lines.push(`  - status: ${blocker.status || "open"}`);
            lines.push(`  - options: ${(blocker.options || []).join(" | ") || "n/a"}`);
            lines.push(`  - decision: ${blocker.decision || "pending decision"}`);
            lines.push(`  - next-step: ${blocker.nextStep || "n/a"}`);
        }
    }
    lines.push("");
    await fs.appendFile(logPath, `${lines.join("\n")}\n`, "utf8");
}
// ─── Prompt Building ──────────────────────────────────────────────────────────
function buildUserPrompt(template, state, focusTaskId) {
    const serialized = JSON.stringify(state, null, 2);
    const activeTasks = (Array.isArray(state.tasks) ? state.tasks : []).filter((t) => t.status === "active" || t.status === "pending");
    const focusTask = activeTasks.find((t) => t.id === focusTaskId);
    const mem = (typeof state.memory === "object" && state.memory !== null
        ? state.memory
        : {});
    const plan = (typeof mem.executionPlan === "object" && mem.executionPlan !== null
        ? mem.executionPlan
        : {});
    const orderedTaskIds = Array.isArray(plan.orderedTaskIds)
        ? plan.orderedTaskIds
        : [];
    const orderedTaskPreview = orderedTaskIds
        .slice(0, 12)
        .map((id, idx) => `${idx + 1}. ${id}`)
        .join("\n") || "none";
    const sequentialPreview = (Array.isArray(plan.sequentialTaskIds) ? plan.sequentialTaskIds : []).join(", ") || "none";
    const parallelPreview = (Array.isArray(plan.parallelTaskIds) ? plan.parallelTaskIds : []).join(", ") || "none";
    const base = template
        .replace(/\$\{state\}/g, serialized)
        .replace(/\$\{workspace\}/g, vscode.workspace.name ?? "");
    return `${base}\n\nULTIMATE GOAL:\n${plan.ultimateGoal || "not set"}\n\nFOCUS TASK (must prioritize this unless blocked):\n${focusTaskId ?? "none"}\n\nORDERED TASK QUEUE (auto-planned):\n${orderedTaskPreview}\n\nSEQUENTIAL TASKS:\n${sequentialPreview}\n\nPARALLEL TASKS:\n${parallelPreview}\n\nACTIVE TASKS ONLY:\n${JSON.stringify(activeTasks, null, 2)}\n\nDo not continue done tasks.${focusTask ? `\n\nFOCUS TASK DETAILS:\n${JSON.stringify(focusTask, null, 2)}` : ""}`;
}
function buildCopilotUiPrompt(state, focusTaskId, systemPrompt, userPrompt, bootstrap, modelFamily, cycleTimestamp) {
    const tasks = (Array.isArray(state.tasks) ? state.tasks : []).filter((t) => t.status === "active" || t.status === "pending");
    const lastCycle = (Array.isArray(state.cycleHistory) ? state.cycleHistory : []).slice(-1)[0];
    const modelHint = modelFamily && modelFamily !== "auto"
        ? `Preferred model: ${modelFamily} (UI mode cannot enforce model switching via extension API; chat UI controls the active model).`
        : "Preferred model: auto.";
    if (bootstrap) {
        return `${systemPrompt}\n\n---\n\n${userPrompt}\n\n${modelHint}\nCycle timestamp: ${cycleTimestamp}\n\nThis is the initial context bootstrap for Copilot UI mode. Keep this context and continue autonomously.`;
    }
    return [
        "Continue autonomously using existing chat context.",
        "Do not repeat long background context unless strictly needed.",
        "Finish-max mode: complete as much as possible end-to-end in this cycle.",
        "Avoid repeating the same summary. Do not stop at analysis if implementation is feasible now.",
        "If one task is strategically blocked, document blocker and continue with next planned activity.",
        modelHint,
        `Cycle timestamp: ${cycleTimestamp}`,
        `Previous cycle note: ${lastCycle?.note ?? "n/a"}`,
        `Focus task: ${focusTaskId ?? "none"}`,
        "Active/pending tasks (current snapshot):",
        JSON.stringify(tasks, null, 2),
        "Return normal answer and end with <agent-update> JSON block.",
    ].join("\n\n");
}
// ─── LM API Integration ───────────────────────────────────────────────────────
/**
 * Calls the VS Code Language Model API (available in VS Code 1.90+).
 * Falls back gracefully if not available.
 */
async function callLM(systemPromptText, userPromptText, modelFamily) {
    try {
        // vscode.lm is available from VS Code 1.90+; we use a safe cast to avoid
        // compile-time errors when @types/vscode < 1.90 is installed.
        const lmApi = vscode.lm;
        if (!lmApi?.selectChatModels) {
            return null; // VS Code too old or LM API not available
        }
        const requestedFamily = (modelFamily || "").trim().toLowerCase();
        let models = [];
        if (requestedFamily && requestedFamily !== "auto") {
            models = await lmApi.selectChatModels({
                vendor: "copilot",
                family: requestedFamily,
            });
        }
        // Auto mode or unavailable family -> use the first available copilot model.
        if (!models || models.length === 0) {
            models = await lmApi.selectChatModels({ vendor: "copilot" });
            if (!models || models.length === 0) {
                return null;
            }
        }
        const allModels = models;
        const model = allModels[0];
        const LMMsg = vscode.LanguageModelChatMessage;
        const cts = new vscode.CancellationTokenSource();
        const timeoutId = setTimeout(() => cts.cancel(), 120000); // 2 min
        try {
            const combinedPrompt = `${systemPromptText}\n\n---\n\n${userPromptText}`;
            const messages = [LMMsg.User(combinedPrompt)];
            const response = await model.sendRequest(messages, {}, cts.token);
            let fullText = "";
            for await (const chunk of response.text) {
                fullText += chunk;
            }
            return fullText;
        }
        finally {
            clearTimeout(timeoutId);
            cts.dispose();
        }
    }
    catch (error) {
        console.error("[Agent] LM API error:", error);
        return null;
    }
}
function parseAgentUpdate(text) {
    const match = text.match(/<agent-update>([\s\S]*?)<\/agent-update>/);
    if (!match) {
        return null;
    }
    try {
        return JSON.parse(match[1].trim());
    }
    catch (e) {
        console.error("[Agent] Failed to parse agent update JSON:", e);
        return null;
    }
}
async function applyAgentUpdate(state, update) {
    const tasks = Array.isArray(state.tasks) ? [...state.tasks] : [];
    const mem = (typeof state.memory === "object" && state.memory !== null
        ? { ...state.memory }
        : {});
    const blockers = Array.isArray(mem.blockers) ? [...mem.blockers] : [];
    // Patch existing tasks
    for (const patch of update.taskUpdates ?? []) {
        if (!patch.id) {
            continue;
        }
        const idx = tasks.findIndex((t) => t.id === patch.id);
        if (idx >= 0) {
            const current = tasks[idx];
            // Guardrail: once done, a task is not re-opened accidentally by model patches.
            if (current.status === "done" &&
                patch.status &&
                patch.status !== "done") {
                const { status, ...rest } = patch;
                tasks[idx] = { ...current, ...rest };
            }
            else {
                tasks[idx] = { ...current, ...patch };
            }
        }
    }
    // Mark tasks done (applied after patches so completion wins deterministically)
    for (const id of update.completedTaskIds ?? []) {
        const idx = tasks.findIndex((t) => t.id === id);
        if (idx >= 0) {
            tasks[idx] = {
                ...tasks[idx],
                status: "done",
                completedAt: new Date().toISOString(),
            };
        }
    }
    // Add new tasks
    for (const task of update.newTasks ?? []) {
        if (!tasks.find((t) => t.id === task.id)) {
            tasks.push(task);
        }
    }
    // Update memory
    if (update.memoryUpdate) {
        Object.assign(mem, update.memoryUpdate);
    }
    // Record blockers
    for (const b of update.blockers ?? []) {
        const incoming = normalizeBlocker(b, `blocker-${Date.now()}-${blockers.length + 1}`);
        const existingIdx = blockers.findIndex((x) => x.id === incoming.id);
        if (existingIdx >= 0) {
            blockers[existingIdx] = {
                ...blockers[existingIdx],
                ...incoming,
                updatedAt: new Date().toISOString(),
            };
        }
        else {
            blockers.push(incoming);
        }
        if (b.relatedTaskId) {
            const taskIdx = tasks.findIndex((t) => t.id === b.relatedTaskId);
            if (taskIdx >= 0 && tasks[taskIdx].status !== "done") {
                tasks[taskIdx] = { ...tasks[taskIdx], status: "blocked" };
            }
        }
    }
    if (blockers.length > 0) {
        mem.blockers = blockers;
    }
    // Normalize status/completedAt consistency to avoid stale UI and state drift.
    for (let i = 0; i < tasks.length; i += 1) {
        const t = tasks[i];
        if (t.status === "done") {
            if (!t.completedAt) {
                tasks[i] = { ...t, completedAt: new Date().toISOString() };
            }
        }
        else if (t.completedAt) {
            const { completedAt, ...rest } = t;
            tasks[i] = { ...rest };
        }
    }
    const activeOrPending = tasks
        .filter((t) => t.status === "active" || t.status === "pending")
        .sort((a, b) => PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority]);
    if (!activeOrPending.find((t) => t.id === mem.currentFocus)) {
        mem.currentFocus = activeOrPending[0]?.id;
    }
    mem.lastLMResponseAt = new Date().toISOString();
    mem.totalCyclesRun = (mem.totalCyclesRun ?? 0) + 1;
    return { ...state, tasks, memory: mem };
}
// ─── Cycle Execution ──────────────────────────────────────────────────────────
async function executeCycle() {
    if (isExecuting) {
        return;
    }
    isExecuting = true;
    updateStatusBar();
    const startedAt = Date.now();
    const config = getConfig();
    const statePath = resolveStatePath(config);
    let state = autoPlanTasksFromProjects(await loadState(statePath));
    let shouldStopScheduler = false;
    let stopReason = "";
    let scheduleImmediateNext = false;
    let continuousIterations = 0;
    try {
        // Keep currentFocus aligned with actual active/pending tasks before prompting the model.
        const tasks = Array.isArray(state.tasks) ? state.tasks : [];
        const focusMem = (typeof state.memory === "object" && state.memory !== null
            ? state.memory
            : {});
        const activeOrPending = tasks
            .filter((t) => t.status === "active" || t.status === "pending")
            .sort((a, b) => PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority]);
        if (!activeOrPending.find((t) => t.id === focusMem.currentFocus)) {
            focusMem.currentFocus = activeOrPending[0]?.id;
            state.memory = focusMem;
        }
        do {
            continuousIterations += 1;
            if (config.backupStateOnCycle) {
                await backupState(statePath);
            }
            const sysPrompt = config.systemPrompt.trim() || SYSTEM_PROMPT_DEFAULT;
            state = autoPlanTasksFromProjects(state);
            const promptTasks = Array.isArray(state.tasks) ? state.tasks : [];
            const promptActiveOrPending = promptTasks
                .filter((t) => t.status === "active" || t.status === "pending")
                .sort((a, b) => PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority]);
            const focusTaskId = promptActiveOrPending.find((t) => t.id === state.memory?.currentFocus)?.id ?? promptActiveOrPending[0]?.id;
            const userPrompt = buildUserPrompt(config.promptTemplate, state, focusTaskId);
            const stateMem = (typeof state.memory === "object" && state.memory !== null
                ? state.memory
                : {});
            const uiBootstrap = !stateMem.uiContextBootstrapped;
            const combinedPrompt = config.executionMode === "copilot-ui"
                ? buildCopilotUiPrompt(state, focusTaskId, sysPrompt, userPrompt, uiBootstrap, config.modelFamily, new Date().toISOString())
                : `${sysPrompt}\n\n---\n\n${userPrompt}`;
            if (config.executionMode === "copilot-ui") {
                await openCopilotChatUI(config, combinedPrompt);
                const memUi = (typeof state.memory === "object" && state.memory !== null
                    ? state.memory
                    : {});
                memUi.uiContextBootstrapped = true;
                state.memory = memUi;
            }
            // In Copilot UI mode we still try LM API in parallel as a tracking overlay,
            // so task/progress state can keep evolving without manual updates.
            const lmResponse = await callLM(sysPrompt, userPrompt, config.modelFamily);
            let outcome = "triggered";
            let cycleNote = "";
            if (lmResponse) {
                outcome =
                    config.executionMode === "copilot-ui" ? "ui-agent" : "lm-success";
                const update = parseAgentUpdate(lmResponse);
                if (update) {
                    const cycleTimestamp = new Date().toISOString();
                    state = await applyAgentUpdate(state, update);
                    state = autoPlanTasksFromProjects(state);
                    await appendStrategicLog(statePath, cycleTimestamp, update);
                    cycleNote =
                        update.cycleNote ??
                            (config.executionMode === "copilot-ui"
                                ? "Copilot UI cycle synced with LM tracking overlay."
                                : "LM cycle complete.");
                    const hasActiveOrPending = (Array.isArray(state.tasks) ? state.tasks : []).some((t) => t.status === "active" || t.status === "pending");
                    const hasBlocked = (Array.isArray(state.tasks) ? state.tasks : []).some((t) => t.status === "blocked");
                    const reachedThreshold = typeof update.progressPercent === "number" &&
                        update.progressPercent >= config.completionThresholdPercent;
                    if (reachedThreshold && focusTaskId) {
                        const tasksNow = Array.isArray(state.tasks) ? [...state.tasks] : [];
                        const idx = tasksNow.findIndex((t) => t.id === focusTaskId);
                        if (idx >= 0 && tasksNow[idx].status !== "done") {
                            tasksNow[idx] = {
                                ...tasksNow[idx],
                                status: "done",
                                completedAt: new Date().toISOString(),
                            };
                            state.tasks = tasksNow;
                        }
                    }
                    if (config.autoStopOnObjectiveReached) {
                        if (update.objectiveReached) {
                            shouldStopScheduler = true;
                            stopReason =
                                update.objectiveSummary?.trim() ||
                                    "Objective reached by agent decision.";
                        }
                        else if (reachedThreshold) {
                            shouldStopScheduler = true;
                            stopReason = `Progress threshold reached (${update.progressPercent}%).`;
                        }
                        else if (!hasActiveOrPending && !hasBlocked) {
                            shouldStopScheduler = true;
                            stopReason = "No active or pending tasks remaining.";
                        }
                    }
                }
                else {
                    cycleNote = "LM responded but no <agent-update> block found.";
                }
                state.lastResults = {
                    triggeredAt: new Date().toISOString(),
                    lmResponse: lmResponse.slice(0, 20000),
                    duration: Date.now() - startedAt,
                };
                const responseLog = Array.isArray(state.lmResponses)
                    ? state.lmResponses
                    : [];
                responseLog.push({
                    timestamp: new Date().toISOString(),
                    outcome,
                    note: cycleNote,
                    duration: Date.now() - startedAt,
                    response: lmResponse.slice(0, 20000),
                });
                state.lmResponses = responseLog.slice(-200);
            }
            else {
                if (config.executionMode === "copilot-ui") {
                    outcome = "ui-agent";
                    cycleNote = uiBootstrap
                        ? "Copilot UI bootstrap prompt sent."
                        : "Copilot UI follow-up prompt sent (compact context).";
                    if (config.modelFamily && config.modelFamily !== "auto") {
                        cycleNote += ` Model preference '${config.modelFamily}' was included, but UI mode model switching remains controlled by chat UI.`;
                    }
                }
                else {
                    outcome = "lm-fallback";
                    cycleNote =
                        "LM API unavailable — opened Copilot Chat UI for manual review.";
                    await openCopilotChatUI(config, combinedPrompt);
                }
                state.lastResults = {
                    triggeredAt: new Date().toISOString(),
                    fallback: config.executionMode !== "copilot-ui",
                    uiAgentMode: config.executionMode === "copilot-ui",
                    requestedModelFamily: config.modelFamily,
                    promptPreview: combinedPrompt.slice(0, 4000),
                    lastPrompt: combinedPrompt.slice(0, 20000),
                };
                const responseLog = Array.isArray(state.lmResponses)
                    ? state.lmResponses
                    : [];
                responseLog.push({
                    timestamp: new Date().toISOString(),
                    outcome,
                    note: cycleNote,
                    duration: Date.now() - startedAt,
                    response: "",
                });
                state.lmResponses = responseLog.slice(-200);
            }
            const history = Array.isArray(state.cycleHistory)
                ? state.cycleHistory
                : [];
            history.push({
                timestamp: new Date().toISOString(),
                outcome,
                note: cycleNote,
                duration: Date.now() - startedAt,
            });
            state.cycleHistory = history.slice(-100);
            const mem = (typeof state.memory === "object" && state.memory !== null
                ? state.memory
                : {});
            mem.lastCycleAt = new Date().toISOString();
            state.memory = mem;
            const qualitySnapshot = computeQualitySnapshot(state);
            const qualityHistory = Array.isArray(state.qualityHistory)
                ? state.qualityHistory
                : [];
            qualityHistory.push(qualitySnapshot);
            state.latestQuality = qualitySnapshot;
            state.qualityHistory = qualityHistory.slice(-200);
            await saveState(statePath, state);
            if (isSchedulerRunning) {
                schedulerCycleCount += 1;
                if (config.maxIterations > 0 &&
                    schedulerCycleCount >= config.maxIterations) {
                    shouldStopScheduler = true;
                    stopReason = `Maximum iterations reached (${config.maxIterations}).`;
                }
            }
            if (continuousIterations >= config.maxAutonomousIterationsPerRun) {
                shouldStopScheduler = true;
                stopReason = `Max autonomous iterations per run reached (${config.maxAutonomousIterationsPerRun}).`;
            }
            if (dashboardPanel) {
                await sendDashboardData(dashboardPanel);
                await sendDashboardMessage(dashboardPanel, `Cycle done [${outcome}]: ${cycleNote}`);
            }
            scheduleImmediateNext =
                config.autonomousExecutionMode === "continuous" &&
                    isSchedulerRunning &&
                    !shouldStopScheduler;
            if (scheduleImmediateNext &&
                config.executionMode === "copilot-ui" &&
                config.uiContinuousDelayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, config.uiContinuousDelayMs));
            }
        } while (scheduleImmediateNext);
        if (shouldStopScheduler && isSchedulerRunning) {
            stopScheduler(stopReason);
            if (dashboardPanel) {
                await sendDashboardMessage(dashboardPanel, `Scheduler auto-stopped: ${stopReason}`);
            }
        }
    }
    catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        const history = Array.isArray(state.cycleHistory) ? state.cycleHistory : [];
        history.push({
            timestamp: new Date().toISOString(),
            outcome: "error",
            note: errMsg,
        });
        state.cycleHistory = history.slice(-100);
        try {
            await saveState(statePath, state);
        }
        catch {
            /* ignore */
        }
        vscode.window.showErrorMessage(`Agent cycle error: ${errMsg}`);
    }
    finally {
        isExecuting = false;
        updateStatusBar();
    }
}
async function openCopilotChatUI(config, prompt) {
    const candidateCommands = [
        config.copilotOpenCommand,
        "workbench.action.chat.open",
        "github.copilot-chat.open",
        "workbench.panel.chat.view.copilot.focus",
        "workbench.action.chat.focus",
    ].filter((v, i, arr) => typeof v === "string" && v.length > 0 && arr.indexOf(v) === i);
    try {
        for (const cmd of candidateCommands) {
            try {
                if (config.copilotOpenArgs !== null) {
                    await vscode.commands.executeCommand(cmd, config.copilotOpenArgs);
                }
                else {
                    await vscode.commands.executeCommand(cmd, prompt);
                }
                return;
            }
            catch {
                // Try next known command
            }
        }
        // Last attempt: open chat UI without prompt injection.
        await vscode.commands.executeCommand("workbench.action.chat.open");
        vscode.window.showWarningMessage("Copilot Chat opened, but prompt injection was not available. Please paste prompt manually if needed.");
        return;
    }
    catch {
        const doc = await vscode.workspace.openTextDocument({
            content: prompt,
            language: "text",
        });
        await vscode.window.showTextDocument(doc, { preview: false });
        vscode.window.showWarningMessage("Copilot Chat not available — prompt opened in editor.");
    }
}
// ─── Dashboard ────────────────────────────────────────────────────────────────
async function openDashboard(context) {
    if (dashboardPanel) {
        dashboardPanel.reveal();
        return;
    }
    dashboardPanel = vscode.window.createWebviewPanel("scheduledCopilotAgentDashboard", "Agent Dashboard", vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
    dashboardPanel.onDidDispose(() => {
        dashboardPanel = undefined;
    }, null, context.subscriptions);
    dashboardPanel.webview.onDidReceiveMessage(async (message) => {
        try {
            await handleDashboardMessage(message, dashboardPanel);
        }
        catch (error) {
            if (dashboardPanel) {
                await sendDashboardMessage(dashboardPanel, `Error: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }, null, context.subscriptions);
    dashboardPanel.webview.html = getDashboardHtml();
    await sendDashboardData(dashboardPanel);
}
async function handleDashboardMessage(message, panel) {
    const markUserEdit = (task) => ({
        ...task,
        userModified: true,
        userModifiedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });
    switch (message.command) {
        case "refresh":
            await sendDashboardData(panel);
            break;
        case "saveState": {
            const config = getConfig();
            const statePath = resolveStatePath(config);
            const newState = JSON.parse(message.stateJson);
            await saveState(statePath, newState);
            await sendDashboardMessage(panel, "State saved.");
            await sendDashboardData(panel);
            break;
        }
        case "saveConfig": {
            const cfg = vscode.workspace.getConfiguration("scheduledCopilotAgent");
            const c = message.config;
            await cfg.update("intervalSeconds", c.intervalSeconds, vscode.ConfigurationTarget.Workspace);
            // Keep legacy setting in sync for backwards compatibility.
            if (typeof c.intervalSeconds === "number") {
                await cfg.update("intervalMinutes", c.intervalSeconds / 60, vscode.ConfigurationTarget.Workspace);
            }
            await cfg.update("uiContinuousDelayMs", c.uiContinuousDelayMs, vscode.ConfigurationTarget.Workspace);
            await cfg.update("requireManualStart", c.requireManualStart, vscode.ConfigurationTarget.Workspace);
            await cfg.update("stateFilePath", c.stateFilePath, vscode.ConfigurationTarget.Workspace);
            await cfg.update("importFolderPath", c.importFolderPath, vscode.ConfigurationTarget.Workspace);
            await cfg.update("promptTemplate", c.promptTemplate, vscode.ConfigurationTarget.Workspace);
            await cfg.update("launchOnActivate", c.launchOnActivate, vscode.ConfigurationTarget.Workspace);
            await cfg.update("dailyTriggerTimes", c.dailyTriggerTimes, vscode.ConfigurationTarget.Workspace);
            await cfg.update("modelFamily", c.modelFamily, vscode.ConfigurationTarget.Workspace);
            await cfg.update("systemPrompt", c.systemPrompt, vscode.ConfigurationTarget.Workspace);
            await cfg.update("backupStateOnCycle", c.backupStateOnCycle, vscode.ConfigurationTarget.Workspace);
            await cfg.update("autoStopOnObjectiveReached", c.autoStopOnObjectiveReached, vscode.ConfigurationTarget.Workspace);
            await cfg.update("maxIterations", c.maxIterations, vscode.ConfigurationTarget.Workspace);
            await cfg.update("autonomousExecutionMode", c.autonomousExecutionMode, vscode.ConfigurationTarget.Workspace);
            await cfg.update("completionThresholdPercent", c.completionThresholdPercent, vscode.ConfigurationTarget.Workspace);
            await cfg.update("maxAutonomousIterationsPerRun", c.maxAutonomousIterationsPerRun, vscode.ConfigurationTarget.Workspace);
            await cfg.update("executionMode", c.executionMode, vscode.ConfigurationTarget.Workspace);
            await sendDashboardMessage(panel, "Settings saved.");
            break;
        }
        case "importKnowledgeInbox": {
            const count = await importKnowledgeInbox();
            await sendDashboardMessage(panel, `Imported ${count} inbox item(s).`);
            await sendDashboardData(panel);
            break;
        }
        case "triggerNow":
            void executeCycle();
            await sendDashboardMessage(panel, "Cycle triggered…");
            break;
        case "bootstrapWorkspaceAudit": {
            const config = getConfig();
            const statePath = resolveStatePath(config);
            const result = await ensureWorkspaceAuditState(statePath, {
                force: true,
                reason: "dashboard-manual",
            });
            await sendDashboardData(panel);
            await sendDashboardMessage(panel, `${result.message}\n${result.validation}`);
            break;
        }
        case "validateWorkspacePlan": {
            const config = getConfig();
            const statePath = resolveStatePath(config);
            const state = await loadState(statePath);
            const message = buildStateValidationMessage(state);
            await saveState(statePath, {
                ...state,
                memory: {
                    ...(state.memory || {}),
                    lastValidationReport: message,
                    lastValidationReportAt: new Date().toISOString(),
                },
            });
            await sendDashboardData(panel);
            await sendDashboardMessage(panel, message);
            break;
        }
        case "startScheduler":
            await startScheduler();
            await sendDashboardMessage(panel, "Scheduler started.");
            break;
        case "stopScheduler":
            stopScheduler();
            await sendDashboardMessage(panel, "Scheduler stopped.");
            break;
        case "completeTask": {
            const config = getConfig();
            const statePath = resolveStatePath(config);
            const state = await loadState(statePath);
            const tasks = Array.isArray(state.tasks) ? [...state.tasks] : [];
            const idx = tasks.findIndex((t) => t.id === message.taskId);
            if (idx >= 0) {
                tasks[idx] = markUserEdit({
                    ...tasks[idx],
                    status: "done",
                    completedAt: new Date().toISOString(),
                });
                await saveState(statePath, { ...state, tasks });
                await sendDashboardData(panel);
                await sendDashboardMessage(panel, `Task marked done.`);
            }
            break;
        }
        case "unblockTask": {
            const config = getConfig();
            const statePath = resolveStatePath(config);
            const state = await loadState(statePath);
            const tasks = Array.isArray(state.tasks) ? [...state.tasks] : [];
            const idx = tasks.findIndex((t) => t.id === message.taskId);
            if (idx >= 0 && tasks[idx].status === "blocked") {
                tasks[idx] = markUserEdit({ ...tasks[idx], status: "pending" });
                await saveState(statePath, { ...state, tasks });
                await sendDashboardData(panel);
                await sendDashboardMessage(panel, "Task moved to pending.");
            }
            break;
        }
        case "addTask": {
            const config = getConfig();
            const statePath = resolveStatePath(config);
            const state = await loadState(statePath);
            const tasks = Array.isArray(state.tasks) ? [...state.tasks] : [];
            const newTask = {
                id: `task-${Date.now()}`,
                description: message.description,
                priority: message.priority || "normal",
                status: "active",
                nextAction: message.nextAction || "",
                projectId: message.projectId || undefined,
                notes: "",
                attachments: [],
                userModified: true,
                userModifiedAt: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            tasks.push(newTask);
            await saveState(statePath, { ...state, tasks });
            await sendDashboardData(panel);
            await sendDashboardMessage(panel, "Task added.");
            break;
        }
        case "deleteTask": {
            const config = getConfig();
            const statePath = resolveStatePath(config);
            const state = await loadState(statePath);
            const tasks = Array.isArray(state.tasks) ? [...state.tasks] : [];
            const filtered = tasks.filter((t) => t.id !== message.taskId);
            await saveState(statePath, { ...state, tasks: filtered });
            await sendDashboardData(panel);
            await sendDashboardMessage(panel, "Task deleted.");
            break;
        }
        case "updateTask": {
            const config = getConfig();
            const statePath = resolveStatePath(config);
            const state = await loadState(statePath);
            const tasks = Array.isArray(state.tasks) ? [...state.tasks] : [];
            const idx = tasks.findIndex((t) => t.id === message.taskId);
            if (idx >= 0) {
                const patch = (message.patch || {});
                const allowedStatus = [
                    "active",
                    "pending",
                    "blocked",
                    "on-hold",
                    "deprecated",
                    "irrelevant",
                    "done",
                ];
                const status = typeof patch.status === "string" &&
                    allowedStatus.includes(patch.status)
                    ? patch.status
                    : tasks[idx].status;
                const priority = patch.priority === "top" ||
                    patch.priority === "high" ||
                    patch.priority === "normal"
                    ? patch.priority
                    : tasks[idx].priority;
                const attachments = Array.isArray(patch.attachments)
                    ? patch.attachments
                        .map((v) => String(v || "").trim())
                        .filter((v) => v.length > 0)
                    : tasks[idx].attachments || [];
                const manualOrderRaw = patch.manualOrder;
                const manualOrder = typeof manualOrderRaw === "number" && Number.isFinite(manualOrderRaw)
                    ? Math.max(0, Math.floor(manualOrderRaw))
                    : tasks[idx].manualOrder;
                tasks[idx] = markUserEdit({
                    ...tasks[idx],
                    description: typeof patch.description === "string"
                        ? patch.description
                        : tasks[idx].description,
                    nextAction: typeof patch.nextAction === "string"
                        ? patch.nextAction
                        : tasks[idx].nextAction,
                    notes: typeof patch.notes === "string" ? patch.notes : tasks[idx].notes,
                    attachments,
                    status,
                    priority,
                    manualOrder,
                    userModified: typeof patch.userModified === "boolean" ? patch.userModified : true,
                    completedAt: status === "done"
                        ? tasks[idx].completedAt || new Date().toISOString()
                        : undefined,
                });
                await saveState(statePath, { ...state, tasks });
                await sendDashboardData(panel);
                await sendDashboardMessage(panel, "Task updated.");
            }
            break;
        }
        case "reorderTask": {
            const config = getConfig();
            const statePath = resolveStatePath(config);
            const state = await loadState(statePath);
            const tasks = Array.isArray(state.tasks) ? [...state.tasks] : [];
            const direction = message.direction === "up" ? -1 : 1;
            const activeIds = tasks
                .filter((t) => t.status === "active" ||
                t.status === "pending" ||
                t.status === "blocked" ||
                t.status === "on-hold")
                .sort((a, b) => (a.order || 9999) - (b.order || 9999))
                .map((t) => t.id);
            const currentIndex = activeIds.indexOf(String(message.taskId || ""));
            const targetIndex = currentIndex + direction;
            if (currentIndex >= 0 &&
                targetIndex >= 0 &&
                targetIndex < activeIds.length) {
                const currentId = activeIds[currentIndex];
                activeIds[currentIndex] = activeIds[targetIndex];
                activeIds[targetIndex] = currentId;
                for (let i = 0; i < activeIds.length; i += 1) {
                    const idx = tasks.findIndex((t) => t.id === activeIds[i]);
                    if (idx >= 0) {
                        tasks[idx] = markUserEdit({
                            ...tasks[idx],
                            manualOrder: i + 1,
                        });
                    }
                }
                await saveState(statePath, { ...state, tasks });
                await sendDashboardData(panel);
                await sendDashboardMessage(panel, "Task order updated.");
            }
            break;
        }
        case "dragDropTask": {
            const config = getConfig();
            const statePath = resolveStatePath(config);
            const state = await loadState(statePath);
            const tasks = Array.isArray(state.tasks) ? [...state.tasks] : [];
            const taskId = String(message.taskId || "");
            const targetTaskId = String(message.targetTaskId || "");
            const targetStatus = String(message.targetStatus || "");
            const dropStatuses = ["active", "pending", "blocked", "on-hold"];
            const sourceIdx = tasks.findIndex((t) => t.id === taskId);
            if (sourceIdx < 0) {
                break;
            }
            if (dropStatuses.includes(targetStatus)) {
                tasks[sourceIdx] = markUserEdit({
                    ...tasks[sourceIdx],
                    status: targetStatus,
                });
            }
            const orderedIds = tasks
                .filter((t) => t.status === "active" ||
                t.status === "pending" ||
                t.status === "blocked" ||
                t.status === "on-hold")
                .sort((a, b) => {
                const ma = typeof a.manualOrder === "number" ? a.manualOrder : 99999;
                const mb = typeof b.manualOrder === "number" ? b.manualOrder : 99999;
                if (ma !== mb) {
                    return ma - mb;
                }
                return (a.order || 99999) - (b.order || 99999);
            })
                .map((t) => t.id)
                .filter((id) => id !== taskId);
            let insertAt = orderedIds.indexOf(targetTaskId);
            if (insertAt < 0) {
                if (dropStatuses.includes(targetStatus)) {
                    let lastMatching = -1;
                    for (let i = 0; i < orderedIds.length; i += 1) {
                        const idx = tasks.findIndex((t) => t.id === orderedIds[i]);
                        if (idx >= 0 && tasks[idx].status === targetStatus) {
                            lastMatching = i;
                        }
                    }
                    insertAt = lastMatching >= 0 ? lastMatching + 1 : orderedIds.length;
                }
                else {
                    insertAt = orderedIds.length;
                }
            }
            orderedIds.splice(insertAt, 0, taskId);
            for (let i = 0; i < orderedIds.length; i += 1) {
                const idx = tasks.findIndex((t) => t.id === orderedIds[i]);
                if (idx >= 0) {
                    tasks[idx] = markUserEdit({
                        ...tasks[idx],
                        manualOrder: i + 1,
                    });
                }
            }
            await saveState(statePath, { ...state, tasks });
            await sendDashboardData(panel);
            await sendDashboardMessage(panel, "Task moved by drag and drop.");
            break;
        }
        case "backupState": {
            const config = getConfig();
            const statePath = resolveStatePath(config);
            await backupState(statePath);
            await sendDashboardMessage(panel, "State backed up.");
            break;
        }
    }
}
async function sendDashboardMessage(panel, message) {
    panel.webview.postMessage({ type: "status", message });
}
async function sendDashboardData(panel) {
    const config = getConfig();
    const statePath = resolveStatePath(config);
    const state = await loadState(statePath);
    const enrichedState = state.latestQuality
        ? state
        : { ...state, latestQuality: computeQualitySnapshot(state) };
    const availableModels = await getAvailableCopilotModelFamilies();
    panel.webview.postMessage({
        type: "init",
        config: {
            stateFilePath: config.stateFilePath,
            importFolderPath: config.importFolderPath,
            intervalSeconds: config.intervalSeconds,
            uiContinuousDelayMs: config.uiContinuousDelayMs,
            requireManualStart: config.requireManualStart,
            promptTemplate: config.promptTemplate,
            launchOnActivate: config.launchOnActivate,
            dailyTriggerTimes: config.dailyTriggerTimes,
            modelFamily: config.modelFamily,
            systemPrompt: config.systemPrompt,
            backupStateOnCycle: config.backupStateOnCycle,
            autoStopOnObjectiveReached: config.autoStopOnObjectiveReached,
            maxIterations: config.maxIterations,
            autonomousExecutionMode: config.autonomousExecutionMode,
            completionThresholdPercent: config.completionThresholdPercent,
            maxAutonomousIterationsPerRun: config.maxAutonomousIterationsPerRun,
            executionMode: config.executionMode,
        },
        availableModels,
        statePath,
        state: enrichedState,
        workspaceName: vscode.workspace.name ?? "",
        schedulerRunning: isSchedulerRunning,
        isExecuting,
    });
}
// ─── Dashboard HTML ───────────────────────────────────────────────────────────
function getDashboardHtml() {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Agent Dashboard</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .header { display:flex; align-items:center; gap:10px; padding:10px 16px; border-bottom:1px solid var(--vscode-editorWidget-border); background: var(--vscode-titleBar-activeBackground); }
    .header h1 { margin:0; font-size:14px; font-weight:600; flex:1; }
    .dot { width:9px; height:9px; border-radius:50%; background:#6b6b6b; }
    .dot.running { background:#4caf50; }
    .dot.executing { background:#ff9800; animation: blink .8s infinite; }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.35} }
    #modeIndicator { font-size:10px; font-weight:700; text-transform:uppercase; padding:2px 7px; border-radius:4px; background:var(--vscode-badge-background); color:var(--vscode-badge-foreground); }
    #modeIndicator.continuous { background:#2e7d32; color:#fff; }
    #modeIndicator.interval { background:#1565c0; color:#fff; }
    #lastCycleInfo { font-size:11px; color:var(--vscode-descriptionForeground); }

    .tabs { display:flex; overflow-x:auto; border-bottom:1px solid var(--vscode-editorWidget-border); background: var(--vscode-editorGroupHeader-tabsBackground); }
    .tab { padding:9px 13px; font-size:12px; cursor:pointer; border-bottom:2px solid transparent; white-space:nowrap; }
    .tab.active { border-bottom-color: var(--vscode-button-background); color: var(--vscode-button-background); font-weight:600; }
    .pane { display:none; padding:14px 16px; }
    .pane.active { display:block; }

    .toolbar { display:flex; gap:7px; margin-bottom:12px; flex-wrap:wrap; align-items:center; }
    button { border:none; border-radius:4px; padding:6px 11px; font-size:12px; cursor:pointer; background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
    button:hover { background:var(--vscode-button-hoverBackground); }
    button.sec { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
    button.sec:hover { background:var(--vscode-button-secondaryHoverBackground); }
    button:disabled { opacity:.55; cursor:not-allowed; }
    input, textarea, select { width:100%; border:1px solid var(--vscode-editorWidget-border); border-radius:4px; padding:6px 8px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); font-size:12px; font-family:inherit; }
    textarea { min-height:90px; resize:vertical; }

    .board { display:grid; gap:12px; grid-template-columns:1fr 1fr 1fr 1fr 1fr; }
    .col h3 { margin:0 0 8px 0; font-size:11px; text-transform:uppercase; letter-spacing:.4px; color:var(--vscode-descriptionForeground); }
    .card { border:1px solid var(--vscode-editorWidget-border); background:var(--vscode-editorWidget-background); border-radius:5px; padding:9px; margin-bottom:7px; }
    .badge { display:inline-block; border-radius:3px; font-size:10px; font-weight:700; text-transform:uppercase; margin-right:4px; padding:1px 5px; }
    .badge.top { background:#b71c1c; color:#fff; }
    .badge.high { background:#ef6c00; color:#fff; }
    .badge.normal { background:#2e7d32; color:#fff; }
    .badge.blocked { background:#6a1b9a; color:#fff; }
    .badge.on-hold { background:#5d4037; color:#fff; }
    .badge.deprecated { background:#37474f; color:#fff; }
    .badge.irrelevant { background:#78909c; color:#fff; }
    .badge.done { background:#546e7a; color:#fff; }
    .desc { margin:6px 0 5px 0; font-size:12px; }
    .next { font-size:11px; color:var(--vscode-descriptionForeground); margin-bottom:6px; white-space:pre-wrap; }
    .meta { font-size:10px; color:var(--vscode-descriptionForeground); }
    .task-actions { margin-top:6px; display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
    .task-actions button { padding:4px 7px; font-size:11px; }
    .task-dropzone { min-height:140px; border:1px dashed transparent; border-radius:6px; padding:4px; }
    .task-dropzone.drop-over { border-color: var(--vscode-focusBorder); background: color-mix(in srgb, var(--vscode-focusBorder) 10%, transparent); }
    .task-card.dragging { opacity:.45; }

    .edit-form { display:none; border:1px solid var(--vscode-editorWidget-border); background:var(--vscode-editorWidget-background); border-radius:5px; padding:11px; margin-bottom:12px; }
    .edit-form.open { display:block; }

    .add-form { display:none; border:1px solid var(--vscode-editorWidget-border); background:var(--vscode-editorWidget-background); border-radius:5px; padding:11px; margin-bottom:12px; }
    .add-form.open { display:block; }
    .row2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:8px; }
    .fg label { display:block; font-size:11px; font-weight:600; margin-bottom:4px; }

    .proj-grid, .inbox-grid { display:grid; gap:12px; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); }
    .proj-card, .inbox-card, .blk-item { border:1px solid var(--vscode-editorWidget-border); background:var(--vscode-editorWidget-background); border-radius:5px; padding:10px; }
    .proj-card h4, .inbox-card h5 { margin:0 0 5px 0; font-size:13px; }
    .proj-card .st, .inbox-card .im, .blk-item .bc { font-size:10px; color:var(--vscode-descriptionForeground); margin-bottom:5px; }
    .proj-card .sm { font-size:11px; margin-bottom:7px; white-space:pre-wrap; }
    .proj-card ul { margin:4px 0; padding-left:16px; font-size:11px; }
    .tag { display:inline-block; border-radius:3px; margin-right:3px; margin-bottom:3px; padding:1px 4px; font-size:9px; background:var(--vscode-badge-background); color:var(--vscode-badge-foreground); }

    .hist-row { display:flex; gap:9px; border-bottom:1px solid var(--vscode-editorWidget-border); padding:6px 0; font-size:11px; }
    .hist-row .ts { width:165px; flex-shrink:0; color:var(--vscode-descriptionForeground); }
    .hist-row .oc { width:95px; flex-shrink:0; font-weight:600; }
    .hist-row .ac { width:72px; flex-shrink:0; text-align:right; color:var(--vscode-descriptionForeground); }
    .hist-row .nt { flex:1; }
    .oc.lm-success { color:#4caf50; }
    .oc.lm-fallback { color:#ff9800; }
    .oc.ui-agent { color:#8e24aa; }
    .oc.error { color:#f44336; }
    .oc.triggered { color:#2196f3; }

    .quality-grid { display:grid; gap:12px; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); margin-bottom:12px; }
    .quality-card { border:1px solid var(--vscode-editorWidget-border); border-radius:5px; background:var(--vscode-editorWidget-background); padding:10px; }
    .quality-title { font-size:11px; color:var(--vscode-descriptionForeground); text-transform:uppercase; margin-bottom:6px; }
    .quality-value { font-size:22px; font-weight:700; line-height:1; margin-bottom:4px; }
    .quality-meta { font-size:11px; color:var(--vscode-descriptionForeground); }
    .quality-ok { color:#2e7d32; }
    .quality-warn { color:#ef6c00; }
    .quality-bad { color:#c62828; }

    .lm-layout { display:grid; grid-template-columns:minmax(300px,40%) 1fr; gap:12px; }
    .lm-left { border:1px solid var(--vscode-editorWidget-border); border-radius:5px; max-height:520px; overflow:auto; }
    .lm-item { padding:8px; border-bottom:1px solid var(--vscode-editorWidget-border); cursor:pointer; }
    .lm-item:hover { background:var(--vscode-list-hoverBackground); }
    .lm-item.active { background:var(--vscode-list-activeSelectionBackground); color:var(--vscode-list-activeSelectionForeground); }
    .lm-ts { font-size:10px; color:var(--vscode-descriptionForeground); }
    .lm-note { font-size:11px; margin-top:3px; }
    #lmPreview { min-height:520px; white-space:pre-wrap; font-size:11px; font-family:var(--vscode-editor-font-family); }

    .settings-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
    .cfg { border:1px solid var(--vscode-editorWidget-border); border-radius:5px; padding:10px; margin-bottom:10px; }
    .cfg h4 { margin:0 0 8px 0; font-size:11px; color:var(--vscode-descriptionForeground); text-transform:uppercase; letter-spacing:.4px; }
    .sfg { margin-bottom:9px; }
    .sfg label { display:block; font-size:11px; font-weight:600; margin-bottom:4px; }
    #stateJson { min-height:420px; font-family:var(--vscode-editor-font-family); font-size:11px; }

    .toast { position:fixed; right:16px; bottom:16px; max-width:420px; border:1px solid var(--vscode-notifications-border); background:var(--vscode-notifications-background); border-radius:5px; padding:9px 12px; display:none; font-size:12px; z-index:9999; }
    .empty { font-size:12px; color:var(--vscode-descriptionForeground); }
    #errBanner { display:none; position:fixed; top:0; left:0; right:0; z-index:10000; background:#c0392b; color:#fff; padding:8px 12px; font-size:12px; white-space:pre-wrap; }

    @media (max-width: 980px) {
      .board, .settings-grid, .lm-layout { grid-template-columns:1fr; }
      #lmPreview { min-height:300px; }
    }
  </style>
</head>
<body>
  <div id="errBanner"></div>
  <div class="header">
    <div class="dot" id="dot"></div>
    <h1>Agent Dashboard - <span id="wsName"></span></h1>
    <span id="modeIndicator">-</span>
    <div id="lastCycleInfo">-</div>
  </div>

  <div class="tabs">
    <div class="tab active" data-pane="tasks">Tasks</div>
    <div class="tab" data-pane="projects">Projects</div>
    <div class="tab" data-pane="history">History</div>
    <div class="tab" data-pane="quality">Quality</div>
    <div class="tab" data-pane="inbox">Inbox</div>
    <div class="tab" data-pane="blockers">Blockers</div>
    <div class="tab" data-pane="lm">Last LM Response</div>
    <div class="tab" data-pane="settings">Settings</div>
    <div class="tab" data-pane="json">State JSON</div>
  </div>

  <div class="pane active" id="pane-tasks">
    <div class="toolbar">
      <button id="btnTrigger">&#9654; Run Cycle Now</button>
      <button id="btnStart" class="sec">Start Scheduler</button>
      <button id="btnStop" class="sec">Stop Scheduler</button>
      <button id="btnBootstrapAudit" class="sec">Audit + Define Goal</button>
      <button id="btnValidatePlan" class="sec">Validate Plan</button>
      <button id="btnShowAdd" class="sec">+ Add Task</button>
      <button id="btnRefresh" class="sec">&#8635; Refresh</button>
    </div>
    <div class="add-form" id="addForm">
      <div class="row2">
        <div class="fg"><label>Description *</label><input id="newDesc" type="text" placeholder="What needs to be done?" /></div>
        <div class="fg"><label>Priority</label><select id="newPri"><option value="top">Top</option><option value="high">High</option><option value="normal" selected>Normal</option></select></div>
      </div>
      <div class="row2">
        <div class="fg"><label>Next Action</label><input id="newNextAction" type="text" placeholder="Concrete next step" /></div>
        <div class="fg"><label>Project ID</label><input id="newProjectId" type="text" placeholder="optional" /></div>
      </div>
      <button id="btnSubmitAdd">Add Task</button>
      <button id="btnCancelAdd" class="sec" style="margin-left:6px">Cancel</button>
    </div>
    <div class="edit-form" id="editForm">
      <div class="row2">
        <div class="fg"><label>Task ID</label><input id="editTaskId" type="text" readonly /></div>
        <div class="fg"><label>Status</label><select id="editStatus"><option value="active">active</option><option value="pending">pending</option><option value="blocked">blocked</option><option value="on-hold">on-hold</option><option value="deprecated">deprecated</option><option value="irrelevant">irrelevant</option><option value="done">done</option></select></div>
      </div>
      <div class="row2">
        <div class="fg"><label>Description</label><input id="editDesc" type="text" /></div>
        <div class="fg"><label>Priority</label><select id="editPri"><option value="top">top</option><option value="high">high</option><option value="normal">normal</option></select></div>
      </div>
      <div class="row2">
        <div class="fg"><label>Next Action</label><input id="editNextAction" type="text" /></div>
        <div class="fg"><label>Manual Order (optional)</label><input id="editManualOrder" type="number" min="0" /></div>
      </div>
      <div class="fg" style="margin-bottom:8px;"><label>Notes</label><textarea id="editNotes" style="min-height:90px;"></textarea></div>
      <div class="fg" style="margin-bottom:8px;"><label>Attachments (comma-separated)</label><input id="editAttachments" type="text" placeholder="url/path1, url/path2" /></div>
      <div class="fg" style="margin-bottom:8px;"><label><input id="editUserModified" type="checkbox" style="width:auto; margin-right:6px;" /> Manual lock / user-modified (agent keeps manual order/status)</label></div>
      <button id="btnSaveTaskEdit">Save Task</button>
      <button id="btnCancelTaskEdit" class="sec" style="margin-left:6px">Cancel</button>
    </div>
    <div class="board">
      <div class="col"><h3>Active</h3><div id="colActive" class="task-dropzone" data-dropstatus="active"></div></div>
      <div class="col"><h3>Pending</h3><div id="colPending" class="task-dropzone" data-dropstatus="pending"></div></div>
      <div class="col"><h3>Blocked</h3><div id="colBlocked" class="task-dropzone" data-dropstatus="blocked"></div></div>
      <div class="col"><h3>On-Hold / Parked</h3><div id="colParked" class="task-dropzone" data-dropstatus="on-hold"></div></div>
      <div class="col"><h3>Done (last 10)</h3><div id="colDone"></div></div>
    </div>
  </div>

  <div class="pane" id="pane-projects">
    <div class="proj-grid" id="projectGrid"></div>
  </div>

  <div class="pane" id="pane-history">
    <div id="historyList"></div>
  </div>

  <div class="pane" id="pane-quality">
    <div class="quality-grid" id="qualityGrid"></div>
    <div id="qualityTimeline"></div>
  </div>

  <div class="pane" id="pane-inbox">
    <div class="toolbar">
      <button id="btnImportInbox">Import Inbox Files</button>
      <button id="btnRefreshInbox" class="sec">Refresh</button>
    </div>
    <div class="inbox-grid" id="inboxGrid"></div>
  </div>

  <div class="pane" id="pane-blockers">
    <div id="blockerList"></div>
  </div>

  <div class="pane" id="pane-lm">
    <div class="lm-layout">
      <div class="lm-left" id="lmList"></div>
      <div class="lm-right"><textarea id="lmPreview" readonly></textarea></div>
    </div>
  </div>

  <div class="pane" id="pane-settings">
    <div class="settings-grid">
      <div>
        <div class="cfg">
          <h4>Paths & Timing</h4>
          <div class="sfg"><label>State file path</label><input id="stateFilePathInput" type="text" /></div>
          <div class="sfg"><label>Import folder path</label><input id="importFolderPathInput" type="text" /></div>
          <div class="sfg"><label>Interval seconds</label><input id="intervalSecondsInput" type="number" min="1" /></div>
          <div class="sfg"><label>UI continuous delay (ms)</label><input id="uiContinuousDelayMsInput" type="number" min="0" /></div>
          <div class="sfg"><label>Daily trigger times (HH:MM comma separated)</label><input id="dailyTimesInput" type="text" placeholder="09:00, 21:00" /></div>
        </div>
        <div class="cfg">
          <h4>Execution</h4>
          <div class="sfg"><label>Execution mode</label><select id="executionModeInput"><option value="lm-api">LM API</option><option value="copilot-ui">Copilot UI</option></select></div>
          <div class="sfg"><label>Autonomous execution mode</label><select id="autonomousModeInput"><option value="continuous">Continuous</option><option value="interval">Interval</option></select></div>
          <div class="sfg"><label>Model family</label><select id="modelFamilyInput"></select></div>
          <div class="sfg"><label>Max iterations (0 = unlimited)</label><input id="maxIterationsInput" type="number" min="0" /></div>
          <div class="sfg"><label>Completion threshold percent</label><input id="completionThresholdInput" type="number" min="1" max="100" /></div>
          <div class="sfg"><label>Max autonomous iterations per run</label><input id="maxAutoIterationsInput" type="number" min="1" /></div>
        </div>
      </div>

      <div>
        <div class="cfg">
          <h4>Behavior</h4>
          <div class="sfg"><label><input id="requireManualStartInput" type="checkbox" style="width:auto; margin-right:6px;" /> Require manual start on activation</label></div>
          <div class="sfg"><label><input id="launchOnActivateInput" type="checkbox" style="width:auto; margin-right:6px;" /> Launch scheduler on activate</label></div>
          <div class="sfg"><label><input id="backupOnCycleInput" type="checkbox" style="width:auto; margin-right:6px;" /> Backup state on each cycle</label></div>
          <div class="sfg"><label><input id="autoStopObjectiveInput" type="checkbox" style="width:auto; margin-right:6px;" /> Auto-stop when objective reached</label></div>
        </div>
        <div class="cfg">
          <h4>Prompts</h4>
          <div class="sfg"><label>Prompt template</label><textarea id="promptTemplateInput"></textarea></div>
          <div class="sfg"><label>System prompt (blank uses built-in)</label><textarea id="systemPromptInput" style="min-height:170px;"></textarea></div>
        </div>
        <div class="toolbar" style="margin-top:6px;">
          <button id="btnSaveSettings">Save Settings</button>
          <button id="btnManualBackup" class="sec">Backup State</button>
        </div>
      </div>
    </div>
  </div>

  <div class="pane" id="pane-json">
    <div class="toolbar">
      <button id="btnSaveState">Save State JSON</button>
      <button id="btnReloadState" class="sec">Reload</button>
    </div>
    <textarea id="stateJson"></textarea>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    const vscode = acquireVsCodeApi();
    const priorityWeight = { top: 3, high: 2, normal: 1 };
    let appState = null;
    let appConfig = null;
    let appModels = [];
    let schedulerRunning = false;
    let isExecuting = false;
    let selectedLmIndex = 0;
    let draggedTaskId = '';

    function escapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function fmtDate(ts) {
      if (!ts) { return '-'; }
      try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
    }

    function showToast(message) {
      const el = document.getElementById('toast');
      if (!el) { return; }
      el.textContent = message;
      el.style.display = 'block';
      setTimeout(() => { el.style.display = 'none'; }, 3200);
    }

    function showErrorBanner(message) {
      const el = document.getElementById('errBanner');
      if (!el) { return; }
      el.style.display = 'block';
      el.textContent = message;
    }

    function hideErrorBanner() {
      const el = document.getElementById('errBanner');
      if (!el) { return; }
      el.style.display = 'none';
      el.textContent = '';
    }

    function updateHeader(workspaceName) {
      document.getElementById('wsName').textContent = workspaceName || '';
      const dot = document.getElementById('dot');
      dot.classList.remove('running', 'executing');
      if (isExecuting) {
        dot.classList.add('executing');
      } else if (schedulerRunning) {
        dot.classList.add('running');
      }

      const modeEl = document.getElementById('modeIndicator');
      modeEl.classList.remove('continuous', 'interval');
      const mode = (appConfig && appConfig.autonomousExecutionMode) ? appConfig.autonomousExecutionMode : 'continuous';
      modeEl.textContent = mode;
      modeEl.classList.add(mode === 'interval' ? 'interval' : 'continuous');

      const last = appState && appState.memory ? appState.memory.lastCycleAt : null;
      const cycles = appState && appState.memory && typeof appState.memory.totalCyclesRun === 'number'
        ? appState.memory.totalCyclesRun
        : 0;
      document.getElementById('lastCycleInfo').textContent = 'Last cycle: ' + fmtDate(last) + ' | total cycles: ' + cycles;
    }

    function renderTaskCard(task, done, blocked) {
      const status = task.status || 'pending';
      const draggableAttr = done ? '' : ' draggable="true"';
      const next = task.nextAction ? '<div class="next">↳ ' + escapeHtml(task.nextAction) + '</div>' : '';
      const notes = task.notes ? '<div class="meta" style="margin-bottom:4px; white-space:pre-wrap;">Notes: ' + escapeHtml(task.notes) + '</div>' : '';
      const attachments = Array.isArray(task.attachments) && task.attachments.length
        ? '<div class="meta" style="margin-bottom:4px;">Attachments: ' + escapeHtml(task.attachments.join(' | ')) + '</div>'
        : '';
      const doneText = done && task.completedAt ? '<span class="meta">Completed: ' + escapeHtml(fmtDate(task.completedAt)) + '</span>' : '';
      const doneButton = done || blocked ? '' : '<button class="sec btn-complete" data-taskid="' + escapeHtml(task.id) + '">Done</button>';
      const unblockButton = blocked ? '<button class="sec btn-unblock" data-taskid="' + escapeHtml(task.id) + '">Unblock</button>' : '';
      const moveButtons = done ? ''
        : '<button class="sec btn-move" data-dir="up" data-taskid="' + escapeHtml(task.id) + '">↑</button>'
        + '<button class="sec btn-move" data-dir="down" data-taskid="' + escapeHtml(task.id) + '">↓</button>';
      const manualState = task.userModified ? 'manual lock' : 'agent managed';

      return ''
        + '<div class="card task-card" data-taskid="' + escapeHtml(task.id || '') + '" data-taskstatus="' + escapeHtml(status) + '"' + draggableAttr + '>'
        + '<span class="badge ' + escapeHtml(task.priority || 'normal') + '">' + escapeHtml(task.priority || 'normal') + '</span>'
        + '<span class="badge ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>'
        + '<div class="desc">' + escapeHtml(task.description || '') + '</div>'
        + next
        + notes
        + attachments
        + '<div class="meta">ID: ' + escapeHtml(task.id || '')
        + (task.projectId ? ' | Project: ' + escapeHtml(task.projectId) : '')
        + (typeof task.order === 'number' ? ' | Order: ' + escapeHtml(String(task.order)) : '')
        + (typeof task.manualOrder === 'number' ? ' | Manual: ' + escapeHtml(String(task.manualOrder)) : '')
        + ' | ' + manualState
        + '</div>'
        + '<div class="task-actions">'
        + doneButton
        + unblockButton
        + '<button class="sec btn-edit" data-taskid="' + escapeHtml(task.id) + '">Edit</button>'
        + '<button class="sec btn-delete" data-taskid="' + escapeHtml(task.id) + '">Delete</button>'
        + moveButtons
        + doneText
        + '</div>'
        + '</div>';
    }

    function sortForBoard(tasks) {
      return tasks.slice().sort((a, b) => {
        const ma = typeof a.manualOrder === 'number' ? a.manualOrder : Number.MAX_SAFE_INTEGER;
        const mb = typeof b.manualOrder === 'number' ? b.manualOrder : Number.MAX_SAFE_INTEGER;
        if (ma !== mb) { return ma - mb; }
        const oa = typeof a.order === 'number' ? a.order : Number.MAX_SAFE_INTEGER;
        const ob = typeof b.order === 'number' ? b.order : Number.MAX_SAFE_INTEGER;
        if (oa !== ob) { return oa - ob; }
        return (priorityWeight[b.priority] || 0) - (priorityWeight[a.priority] || 0);
      });
    }

    function renderTasks() {
      const tasks = Array.isArray(appState && appState.tasks) ? appState.tasks : [];
      const sorted = sortForBoard(tasks);
      const active = sorted.filter(t => t.status === 'active');
      const pending = sorted.filter(t => t.status === 'pending');
      const blocked = sorted.filter(t => t.status === 'blocked');
      const parked = sorted.filter(t => t.status === 'on-hold' || t.status === 'deprecated' || t.status === 'irrelevant');
      const done = sorted.filter(t => t.status === 'done').slice(-10).reverse();

      const activeEl = document.getElementById('colActive');
      const pendingEl = document.getElementById('colPending');
      const blockedEl = document.getElementById('colBlocked');
      const parkedEl = document.getElementById('colParked');
      const doneEl = document.getElementById('colDone');

      activeEl.innerHTML = active.length ? active.map(t => renderTaskCard(t, false, false)).join('') : '<div class="empty">No active tasks.</div>';
      pendingEl.innerHTML = pending.length ? pending.map(t => renderTaskCard(t, false, false)).join('') : '<div class="empty">No pending tasks.</div>';
      blockedEl.innerHTML = blocked.length ? blocked.map(t => renderTaskCard(t, false, true)).join('') : '<div class="empty">No blocked tasks.</div>';
      parkedEl.innerHTML = parked.length ? parked.map(t => renderTaskCard(t, false, false)).join('') : '<div class="empty">No parked tasks.</div>';
      doneEl.innerHTML = done.length ? done.map(t => renderTaskCard(t, true, false)).join('') : '<div class="empty">No completed tasks yet.</div>';
      wireTaskDragAndDrop();

      document.querySelectorAll('.btn-complete').forEach(btn => {
        btn.addEventListener('click', () => {
          const taskId = btn.getAttribute('data-taskid');
          if (!taskId) { return; }
          vscode.postMessage({ command: 'completeTask', taskId });
        });
      });

      document.querySelectorAll('.btn-unblock').forEach(btn => {
        btn.addEventListener('click', () => {
          const taskId = btn.getAttribute('data-taskid');
          if (!taskId) { return; }
          vscode.postMessage({ command: 'unblockTask', taskId });
        });
      });

      document.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', () => {
          const taskId = btn.getAttribute('data-taskid');
          if (!taskId) { return; }
          const ok = confirm('Delete task ' + taskId + '?');
          if (!ok) { return; }
          vscode.postMessage({ command: 'deleteTask', taskId });
        });
      });

      document.querySelectorAll('.btn-move').forEach(btn => {
        btn.addEventListener('click', () => {
          const taskId = btn.getAttribute('data-taskid');
          const direction = btn.getAttribute('data-dir');
          if (!taskId || !direction) { return; }
          vscode.postMessage({ command: 'reorderTask', taskId, direction });
        });
      });

      document.querySelectorAll('.btn-edit').forEach(btn => {
        btn.addEventListener('click', () => {
          const taskId = btn.getAttribute('data-taskid');
          if (!taskId) { return; }
          const task = tasks.find(t => t.id === taskId);
          if (!task) { return; }
          document.getElementById('editTaskId').value = task.id || '';
          document.getElementById('editStatus').value = task.status || 'pending';
          document.getElementById('editDesc').value = task.description || '';
          document.getElementById('editPri').value = task.priority || 'normal';
          document.getElementById('editNextAction').value = task.nextAction || '';
          document.getElementById('editManualOrder').value = typeof task.manualOrder === 'number' ? String(task.manualOrder) : '';
          document.getElementById('editNotes').value = task.notes || '';
          document.getElementById('editAttachments').value = Array.isArray(task.attachments) ? task.attachments.join(', ') : '';
          document.getElementById('editUserModified').checked = !!task.userModified;
          document.getElementById('editForm').classList.add('open');
          document.getElementById('addForm').classList.remove('open');
        });
      });
    }

    function wireTaskDragAndDrop() {
      const cards = document.querySelectorAll('.task-card[draggable="true"]');
      const zones = document.querySelectorAll('.task-dropzone');

      cards.forEach(card => {
        card.addEventListener('dragstart', ev => {
          draggedTaskId = card.getAttribute('data-taskid') || '';
          card.classList.add('dragging');
          if (ev.dataTransfer) {
            ev.dataTransfer.effectAllowed = 'move';
            ev.dataTransfer.setData('text/plain', draggedTaskId);
          }
        });

        card.addEventListener('dragend', () => {
          card.classList.remove('dragging');
          draggedTaskId = '';
          zones.forEach(z => z.classList.remove('drop-over'));
        });
      });

      zones.forEach(zone => {
        zone.addEventListener('dragover', ev => {
          ev.preventDefault();
          zone.classList.add('drop-over');
          if (ev.dataTransfer) {
            ev.dataTransfer.dropEffect = 'move';
          }
        });

        zone.addEventListener('dragleave', () => {
          zone.classList.remove('drop-over');
        });

        zone.addEventListener('drop', ev => {
          ev.preventDefault();
          zone.classList.remove('drop-over');
          if (!draggedTaskId) {
            return;
          }

          const rawTarget = ev.target && ev.target.closest
            ? ev.target.closest('.task-card')
            : null;
          const targetTaskId = rawTarget
            ? (rawTarget.getAttribute('data-taskid') || '')
            : '';
          const targetStatus = zone.getAttribute('data-dropstatus') || '';
          vscode.postMessage({
            command: 'dragDropTask',
            taskId: draggedTaskId,
            targetTaskId,
            targetStatus
          });
        });
      });
    }

    function listItems(items) {
      if (!Array.isArray(items) || items.length === 0) {
        return '<div class="empty">None</div>';
      }
      return '<ul>' + items.map(v => '<li>' + escapeHtml(v) + '</li>').join('') + '</ul>';
    }

    function renderProjects() {
      const projects = Array.isArray(appState && appState.projects) ? appState.projects : [];
      const container = document.getElementById('projectGrid');
      if (!projects.length) {
        container.innerHTML = '<div class="empty">No projects available.</div>';
        return;
      }
      container.innerHTML = projects.map(p => ''
        + '<div class="proj-card">'
        + '<h4>' + escapeHtml(p.name || p.id || 'Unnamed project') + '</h4>'
        + '<div class="st">Status: ' + escapeHtml(p.status || '-') + (p.type ? ' | Type: ' + escapeHtml(p.type) : '') + '</div>'
        + '<div class="sm">' + escapeHtml(p.summary || '') + '</div>'
        + '<div class="meta">Next actions</div>'
        + listItems(p.nextActions)
        + '<div class="meta" style="margin-top:6px;">Open questions</div>'
        + listItems(p.openQuestions)
        + '</div>'
      ).join('');
    }

    function renderHistory() {
      const history = Array.isArray(appState && appState.cycleHistory) ? appState.cycleHistory.slice().reverse() : [];
      const container = document.getElementById('historyList');
      if (!history.length) {
        container.innerHTML = '<div class="empty">No cycle history yet.</div>';
        return;
      }
      container.innerHTML = history.map(h => ''
        + '<div class="hist-row">'
        + '<div class="ts">' + escapeHtml(fmtDate(h.timestamp)) + '</div>'
        + '<div class="oc ' + escapeHtml(h.outcome || 'triggered') + '">' + escapeHtml(h.outcome || '-') + '</div>'
        + '<div class="nt">' + escapeHtml(h.note || '') + '</div>'
        + '<div class="ac">' + (typeof h.duration === 'number' ? escapeHtml((h.duration / 1000).toFixed(1) + 's') : '') + '</div>'
        + '</div>'
      ).join('');
    }

    function qualityClass(value, goal) {
      if (value >= goal) { return 'quality-ok'; }
      if (value >= Math.max(0, goal - 10)) { return 'quality-warn'; }
      return 'quality-bad';
    }

    function renderQuality() {
      const goals = appState && appState.qualityGoals ? appState.qualityGoals : {
        planningQualityMin: 85,
        traceabilityMin: 90,
        stabilityMin: 95
      };

      const latest = appState && appState.latestQuality ? appState.latestQuality : null;
      const history = Array.isArray(appState && appState.qualityHistory)
        ? appState.qualityHistory.slice().reverse().slice(0, 10)
        : [];

      const grid = document.getElementById('qualityGrid');
      const timeline = document.getElementById('qualityTimeline');

      if (!latest) {
        grid.innerHTML = '<div class="empty">No quality snapshot yet. Run one cycle.</div>';
        timeline.innerHTML = '';
        return;
      }

      const cards = [
        {
          title: 'Planning Quality',
          value: latest.planningQualityScore,
          goal: goals.planningQualityMin,
          meta: 'Tasks mit konkretem nextAction'
        },
        {
          title: 'Traceability',
          value: latest.traceabilityScore,
          goal: goals.traceabilityMin,
          meta: 'Blocker mit Status/Optionen/Entscheidung/Nächstem Schritt'
        },
        {
          title: 'Stability',
          value: latest.stabilityScore,
          goal: goals.stabilityMin,
          meta: 'Wenige Fehler/Fallbacks in den letzten 20 Zyklen'
        },
        {
          title: 'State Consistency',
          value: latest.stateConsistencyScore,
          goal: 100,
          meta: 'Eindeutige IDs und konsistenter Zustand'
        }
      ];

      grid.innerHTML = cards.map(c => {
        const cls = qualityClass(c.value, c.goal);
        return ''
          + '<div class="quality-card">'
          + '<div class="quality-title">' + escapeHtml(c.title) + '</div>'
          + '<div class="quality-value ' + cls + '">' + escapeHtml(String(c.value)) + '%</div>'
          + '<div class="quality-meta">Ziel: ' + escapeHtml(String(c.goal)) + '%</div>'
          + '<div class="quality-meta" style="margin-top:4px;">' + escapeHtml(c.meta) + '</div>'
          + '</div>';
      }).join('');

      const tlRows = history.map(h => ''
        + '<div class="hist-row">'
        + '<div class="ts">' + escapeHtml(fmtDate(h.timestamp)) + '</div>'
        + '<div class="oc">P:' + escapeHtml(String(h.planningQualityScore))
        + ' T:' + escapeHtml(String(h.traceabilityScore))
        + ' S:' + escapeHtml(String(h.stabilityScore))
        + ' C:' + escapeHtml(String(h.stateConsistencyScore)) + '</div>'
        + '<div class="nt">Open blockers: ' + escapeHtml(String(h.openBlockers))
        + ' | with decision: ' + escapeHtml(String(h.blockersWithDecision)) + '</div>'
        + '<div class="ac"></div>'
        + '</div>');

      timeline.innerHTML = tlRows.length ? tlRows.join('') : '<div class="empty">No quality history yet.</div>';
    }

    function renderInbox() {
      const items = Array.isArray(appState && appState.knowledgeInbox) ? appState.knowledgeInbox.slice().reverse() : [];
      const container = document.getElementById('inboxGrid');
      if (!items.length) {
        container.innerHTML = '<div class="empty">Inbox is empty.</div>';
        return;
      }
      container.innerHTML = items.map(item => {
        const tags = Array.isArray(item.tags) ? item.tags : [];
        const preview = String(item.content || '').slice(0, 260);
        return ''
          + '<div class="inbox-card">'
          + '<h5>' + escapeHtml(item.title || item.id || 'Untitled') + '</h5>'
          + '<div class="im">' + escapeHtml(item.source || '') + ' | ' + escapeHtml(fmtDate(item.importedAt)) + '</div>'
          + '<div style="margin-bottom:6px;">' + tags.map(tag => '<span class="tag">' + escapeHtml(tag) + '</span>').join('') + '</div>'
          + '<div class="meta" style="white-space:pre-wrap;">' + escapeHtml(preview) + (String(item.content || '').length > 260 ? ' ...' : '') + '</div>'
          + '</div>';
      }).join('');
    }

    function renderBlockers() {
      const blockers = Array.isArray(appState && appState.memory && appState.memory.blockers) ? appState.memory.blockers.slice().reverse() : [];
      const container = document.getElementById('blockerList');
      if (!blockers.length) {
        container.innerHTML = '<div class="empty">No blockers reported.</div>';
        return;
      }
      container.innerHTML = blockers.map(b => ''
        + '<div class="blk-item">'
        + '<div class="st">' + escapeHtml((b.type || 'decision').toUpperCase()) + ' | ' + escapeHtml((b.status || 'open').toUpperCase()) + '</div>'
        + '<div class="desc">' + escapeHtml(b.description || '') + '</div>'
        + '<div class="meta" style="margin:4px 0;">Options: ' + escapeHtml(Array.isArray(b.options) ? b.options.join(' | ') : '') + '</div>'
        + '<div class="meta" style="margin:4px 0;">Decision: ' + escapeHtml(b.decision || 'pending decision') + '</div>'
        + '<div class="meta" style="margin:4px 0;">Next step: ' + escapeHtml(b.nextStep || 'n/a') + '</div>'
        + '<div class="bc">' + escapeHtml(b.id || '-') + ' | ' + escapeHtml(fmtDate(b.createdAt)) + '</div>'
        + '</div>'
      ).join('');
    }

    function renderLmResponses() {
      const responses = Array.isArray(appState && appState.lmResponses) ? appState.lmResponses.slice().reverse() : [];
      const list = document.getElementById('lmList');
      const preview = document.getElementById('lmPreview');
      if (!responses.length) {
        list.innerHTML = '<div class="empty" style="padding:8px;">No LM responses recorded.</div>';
        preview.value = '';
        return;
      }

      if (selectedLmIndex < 0 || selectedLmIndex >= responses.length) {
        selectedLmIndex = 0;
      }

      list.innerHTML = responses.map((r, i) => ''
        + '<div class="lm-item ' + (i === selectedLmIndex ? 'active' : '') + '" data-idx="' + i + '">'
        + '<div class="lm-ts">' + escapeHtml(fmtDate(r.timestamp)) + '</div>'
        + '<div class="lm-note">' + escapeHtml(r.outcome || '-') + (r.note ? ' | ' + escapeHtml(r.note) : '') + '</div>'
        + '</div>'
      ).join('');

      list.querySelectorAll('.lm-item').forEach(item => {
        item.addEventListener('click', () => {
          const raw = item.getAttribute('data-idx');
          selectedLmIndex = raw ? Number(raw) : 0;
          renderLmResponses();
        });
      });

      const selected = responses[selectedLmIndex] || responses[0];
      preview.value = String(selected.response || '').trim();
    }

    function renderSettings() {
      if (!appConfig) { return; }
      document.getElementById('stateFilePathInput').value = appConfig.stateFilePath || 'state.json';
      document.getElementById('importFolderPathInput').value = appConfig.importFolderPath || 'imports';
      document.getElementById('intervalSecondsInput').value = String(appConfig.intervalSeconds || 60);
      document.getElementById('uiContinuousDelayMsInput').value = String(
        typeof appConfig.uiContinuousDelayMs === 'number' ? appConfig.uiContinuousDelayMs : 2500
      );
      document.getElementById('dailyTimesInput').value = Array.isArray(appConfig.dailyTriggerTimes) ? appConfig.dailyTriggerTimes.join(', ') : '';
      document.getElementById('executionModeInput').value = appConfig.executionMode || 'copilot-ui';
      document.getElementById('autonomousModeInput').value = appConfig.autonomousExecutionMode || 'continuous';
      document.getElementById('maxIterationsInput').value = String(appConfig.maxIterations || 0);
      document.getElementById('completionThresholdInput').value = String(appConfig.completionThresholdPercent || 90);
      document.getElementById('maxAutoIterationsInput').value = String(appConfig.maxAutonomousIterationsPerRun || 100);
      document.getElementById('requireManualStartInput').checked = !!appConfig.requireManualStart;
      document.getElementById('launchOnActivateInput').checked = !!appConfig.launchOnActivate;
      document.getElementById('backupOnCycleInput').checked = !!appConfig.backupStateOnCycle;
      document.getElementById('autoStopObjectiveInput').checked = !!appConfig.autoStopOnObjectiveReached;
      document.getElementById('promptTemplateInput').value = appConfig.promptTemplate || '';
      document.getElementById('systemPromptInput').value = appConfig.systemPrompt || '';

      const modelSelect = document.getElementById('modelFamilyInput');
      const modelList = Array.isArray(appModels) && appModels.length ? appModels : ['auto'];
      modelSelect.innerHTML = modelList.map(m => '<option value="' + escapeHtml(m) + '">' + escapeHtml(m) + '</option>').join('');
      modelSelect.value = appConfig.modelFamily || 'auto';
    }

    function renderJsonEditor() {
      const editor = document.getElementById('stateJson');
      editor.value = JSON.stringify(appState || {}, null, 2);
    }

    function renderAll(workspaceName) {
      hideErrorBanner();
      updateHeader(workspaceName || '');
      renderTasks();
      renderProjects();
      renderHistory();
      renderQuality();
      renderInbox();
      renderBlockers();
      renderLmResponses();
      renderSettings();
      renderJsonEditor();

      const triggerBtn = document.getElementById('btnTrigger');
      triggerBtn.disabled = !!isExecuting;
    }

    function wireTabs() {
      document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
          document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
          document.querySelectorAll('.pane').forEach(x => x.classList.remove('active'));
          tab.classList.add('active');
          const pane = document.getElementById('pane-' + tab.getAttribute('data-pane'));
          if (pane) { pane.classList.add('active'); }
        });
      });
    }

    function wireControls() {
      document.getElementById('btnTrigger').addEventListener('click', () => vscode.postMessage({ command: 'triggerNow' }));
      document.getElementById('btnStart').addEventListener('click', () => vscode.postMessage({ command: 'startScheduler' }));
      document.getElementById('btnStop').addEventListener('click', () => vscode.postMessage({ command: 'stopScheduler' }));
      document.getElementById('btnBootstrapAudit').addEventListener('click', () => vscode.postMessage({ command: 'bootstrapWorkspaceAudit' }));
      document.getElementById('btnValidatePlan').addEventListener('click', () => vscode.postMessage({ command: 'validateWorkspacePlan' }));
      document.getElementById('btnRefresh').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
      document.getElementById('btnRefreshInbox').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
      document.getElementById('btnImportInbox').addEventListener('click', () => vscode.postMessage({ command: 'importKnowledgeInbox' }));
      document.getElementById('btnManualBackup').addEventListener('click', () => vscode.postMessage({ command: 'backupState' }));
      document.getElementById('btnReloadState').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));

      document.getElementById('btnShowAdd').addEventListener('click', () => {
        document.getElementById('addForm').classList.add('open');
      });
      document.getElementById('btnCancelAdd').addEventListener('click', () => {
        document.getElementById('addForm').classList.remove('open');
      });

      document.getElementById('btnCancelTaskEdit').addEventListener('click', () => {
        document.getElementById('editForm').classList.remove('open');
      });

      document.getElementById('btnSaveTaskEdit').addEventListener('click', () => {
        const taskId = document.getElementById('editTaskId').value.trim();
        if (!taskId) {
          showToast('Task ID is missing.');
          return;
        }
        const attachmentsRaw = document.getElementById('editAttachments').value.trim();
        const attachments = attachmentsRaw
          ? attachmentsRaw.split(',').map(v => v.trim()).filter(Boolean)
          : [];

        const manualOrderRaw = document.getElementById('editManualOrder').value.trim();
        const manualOrder = manualOrderRaw ? Number(manualOrderRaw) : undefined;

        const patch = {
          description: document.getElementById('editDesc').value,
          status: document.getElementById('editStatus').value,
          priority: document.getElementById('editPri').value,
          nextAction: document.getElementById('editNextAction').value,
          notes: document.getElementById('editNotes').value,
          attachments,
          manualOrder,
          userModified: !!document.getElementById('editUserModified').checked
        };

        vscode.postMessage({ command: 'updateTask', taskId, patch });
        document.getElementById('editForm').classList.remove('open');
      });

      document.getElementById('btnSubmitAdd').addEventListener('click', () => {
        const description = document.getElementById('newDesc').value.trim();
        if (!description) {
          showToast('Description is required.');
          return;
        }
        const priority = document.getElementById('newPri').value;
        const nextAction = document.getElementById('newNextAction').value.trim();
        const projectId = document.getElementById('newProjectId').value.trim();
        vscode.postMessage({ command: 'addTask', description, priority, nextAction, projectId });
        document.getElementById('newDesc').value = '';
        document.getElementById('newNextAction').value = '';
        document.getElementById('newProjectId').value = '';
        document.getElementById('newPri').value = 'normal';
        document.getElementById('addForm').classList.remove('open');
      });

      document.getElementById('btnSaveSettings').addEventListener('click', () => {
        const dailyTimesRaw = document.getElementById('dailyTimesInput').value.trim();
        const dailyTriggerTimes = dailyTimesRaw
          ? dailyTimesRaw.split(',').map(s => s.trim()).filter(Boolean)
          : [];

        const config = {
          stateFilePath: document.getElementById('stateFilePathInput').value.trim() || 'state.json',
          importFolderPath: document.getElementById('importFolderPathInput').value.trim() || 'imports',
          intervalSeconds: Math.max(1, Number(document.getElementById('intervalSecondsInput').value || 60)),
          uiContinuousDelayMs: Math.max(0, Number(document.getElementById('uiContinuousDelayMsInput').value || 0)),
          dailyTriggerTimes,
          executionMode: document.getElementById('executionModeInput').value,
          autonomousExecutionMode: document.getElementById('autonomousModeInput').value,
          modelFamily: document.getElementById('modelFamilyInput').value || 'auto',
          maxIterations: Math.max(0, Number(document.getElementById('maxIterationsInput').value || 0)),
          completionThresholdPercent: Math.min(100, Math.max(1, Number(document.getElementById('completionThresholdInput').value || 90))),
          maxAutonomousIterationsPerRun: Math.max(1, Number(document.getElementById('maxAutoIterationsInput').value || 100)),
          requireManualStart: !!document.getElementById('requireManualStartInput').checked,
          launchOnActivate: !!document.getElementById('launchOnActivateInput').checked,
          backupStateOnCycle: !!document.getElementById('backupOnCycleInput').checked,
          autoStopOnObjectiveReached: !!document.getElementById('autoStopObjectiveInput').checked,
          promptTemplate: document.getElementById('promptTemplateInput').value,
          systemPrompt: document.getElementById('systemPromptInput').value
        };

        vscode.postMessage({ command: 'saveConfig', config });
      });

      document.getElementById('btnSaveState').addEventListener('click', () => {
        const raw = document.getElementById('stateJson').value;
        try {
          JSON.parse(raw);
        } catch (err) {
          showToast('Invalid JSON: ' + String(err));
          return;
        }
        vscode.postMessage({ command: 'saveState', stateJson: raw });
      });
    }

    window.onerror = function(msg, src, line, col) {
      showErrorBanner('JS Error: ' + msg + ' (line ' + line + ', col ' + col + ') in ' + src);
      return false;
    };

    window.onunhandledrejection = function(ev) {
      showErrorBanner('Unhandled Promise: ' + String(ev.reason || ev));
    };

    window.addEventListener('message', event => {
      const message = event.data;
      if (!message || typeof message !== 'object') { return; }

      if (message.type === 'status') {
        showToast(String(message.message || ''));
        return;
      }

      if (message.type === 'init') {
        appConfig = message.config || {};
        appState = message.state || {};
        appModels = Array.isArray(message.availableModels) ? message.availableModels : [];
        schedulerRunning = !!message.schedulerRunning;
        isExecuting = !!message.isExecuting;
        renderAll(message.workspaceName || '');
      }
    });

    wireTabs();
    wireControls();
    vscode.postMessage({ command: 'refresh' });
  </script>
</body>
</html>`;
}
//# sourceMappingURL=extension.js.map
import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  Plus, Calendar as CalendarIcon, Tag, Mic, Sun, Moon,
  CheckCircle2, Filter, Save, Upload, Trash2, Repeat, Bell,
  ChevronDown, ChevronRight, Search, Users, Award
} from "lucide-react";
import * as chrono from "chrono-node";
import {
  format, startOfWeek, addDays, isSameDay, isBefore, addWeeks, addMonths,
  addDays as dfAddDays, isToday
} from "date-fns";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip,
  CartesianGrid, RadialBarChart, RadialBar, PolarAngleAxis
} from "recharts";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";

// 🔗 Firestore persistence (new)
import {
  listenTasks, addTask, updateTask, deleteTask, toggleComplete, USER_ID
} from "./persist";

// --- Utilities ---------------------------------------------------------------
const priorities = ["Low", "Medium", "High"];
const defaultProjects = ["Inbox", "Work", "Personal", "School"];
const areas = ["Personal", "Work"];
function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

function parseQuickInput(text) {
  const meta = { title: text, tags: [], project: "Inbox", priority: "Medium", due: null, repeat: null };
  meta.tags = Array.from(text.matchAll(/#([A-Za-z0-9_-]+)/g)).map(m => m[1]);
  const proj = text.match(/\bp:([A-Za-z0-9 _-]+)/i);
  if (proj) meta.project = proj[1].trim();
  if (/!!/.test(text) || /!high\b/i.test(text)) meta.priority = "High";
  else if (/!low\b/i.test(text)) meta.priority = "Low";
  else if (/!med(iu)?m?\b/i.test(text)) meta.priority = "Medium";
  const rep = text.match(/\bevery\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (rep) meta.repeat = { type: "weekly", weekday: rep[1].toLowerCase() };
  if (/\bdaily\b/i.test(text)) meta.repeat = { type: "daily" };
  if (/\bweekly\b/i.test(text)) meta.repeat = { type: "weekly" };
  if (/\bmonthly\b/i.test(text)) meta.repeat = { type: "monthly" };
  const cleaned = text
    .replace(/#([A-Za-z0-9_-]+)/g, "")
    .replace(/\bp:[A-Za-z0-9 _-]+/gi, "")
    .replace(/!high|!low|!medium|!!/gi, "")
    .replace(/every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|daily|weekly|monthly/gi, "");
  const parsed = chrono.parse(cleaned);
  if (parsed?.[0]?.date) meta.due = parsed[0].date();
  meta.title = cleaned.trim().replace(/\s{2,}/g, " ") || text.trim();
  return meta;
}

function priBorder(p) {
  return p === "High" ? "border-red-400"
       : p === "Medium" ? "border-amber-400"
       : "border-emerald-400";
}

function applyQuery(tasks, q) {
  if (!q.trim()) return tasks.filter(t => !t.completed);
  const parts = q.split(/\s+(AND|OR)\s+/i);
  const evalPart = (task, token) => {
    token = token.trim();
    const mTag = token.match(/^tag:(.+)$/i);
    if (mTag) return (task.tags||[]).includes(mTag[1]);
    const mProj = token.match(/^project:(.+)$/i);
    if (mProj) return (task.project||"").toLowerCase() === mProj[1].toLowerCase();
    const mPri = token.match(/^priority:(high|medium|low)$/i);
    if (mPri) return (task.priority||"").toLowerCase() === mPri[1].toLowerCase();
    const mDue = token.match(/^due:(today|overdue|none)$/i);
    if (mDue) {
      if (mDue[1] === "none") return !task.due;
      if (mDue[1] === "today") return task.due && isToday(new Date(task.due));
      if (mDue[1] === "overdue") return task.due && isBefore(new Date(task.due), new Date()) && !task.completed;
    }
    const mComp = token.match(/^completed:(true|false)$/i);
    if (mComp) return !!task.completed === (mComp[1].toLowerCase() === "true");
    return (task.title||"").toLowerCase().includes(token.toLowerCase());
  };
  let res = tasks;
  if (parts.length === 1) return res.filter(t => evalPart(t, parts[0]));
  let current = res.filter(t => evalPart(t, parts[0]));
  for (let i = 1; i < parts.length; i += 2) {
    const op = parts[i].toUpperCase();
    const token = parts[i+1];
    const match = res.filter(t => evalPart(t, token));
    if (op === "AND") current = current.filter(t => match.includes(t));
    else current = Array.from(new Set([...current, ...match]));
  }
  return current;
}

// --- State -------------------------------------------------------------------
const initial = () => ({
  tasks: [],
  projects: defaultProjects,
  dark: window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches,
  points: 0,
  history: [], // {date: 'YYYY-MM-DD', completed: number}
  collaborators: [],
});

function reducer(state, action) {
  switch (action.type) {
    case "SET_TASKS": return { ...state, tasks: action.tasks };
    case "ADD_PROJECT":
      if (state.projects.includes(action.name)) return state;
      return { ...state, projects: [...state.projects, action.name] };
    case "TOGGLE_DARK": return { ...state, dark: !state.dark };
    case "BULK_IMPORT": return { ...state, ...action.payload };
    default: return state;
  }
}

// --- Components --------------------------------------------------------------
export default function ProTodoApp() {
  const [state, dispatch] = useReducer(reducer, undefined, initial);
  const [query, setQuery] = useState("");
  const [quick, setQuick] = useState("");
  const [quickArea, setQuickArea] = useState("Personal");
  const [voiceListening, setVoiceListening] = useState(false);
  const inputRef = useRef(null);
  const [editingId, setEditingId] = useState(null);

  // Theme toggle (DOM class)
  useEffect(() => { document.documentElement.classList.toggle("dark", state.dark); }, [state.dark]);

  // 🔴 Subscribe to Firestore (source of truth for tasks)
  useEffect(() => {
    const unsub = listenTasks(USER_ID, (tasks) => dispatch({ type: "SET_TASKS", tasks }));
    return unsub;
  }, []);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
      if (e.key === "n") { e.preventDefault(); inputRef.current?.focus(); }
      if (e.key === "/") { e.preventDefault(); document.getElementById("search")?.focus(); }
      if (e.key === "d" && e.shiftKey) { e.preventDefault(); dispatch({ type: "TOGGLE_DARK" }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const [anchorDate, setAnchorDate] = useState(new Date());
  const [selectedDay, setSelectedDay] = useState(new Date());
  const weekStart = useMemo(() => startOfWeek(anchorDate, { weekStartsOn: 1 }), [anchorDate]);
  const weekDays  = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

  const filtered = useMemo(() => applyQuery(state.tasks, query), [state.tasks, query]);

  async function addTaskFromQuick() {
    if (!quick.trim()) return;
    const meta = parseQuickInput(quick);
    let due = meta.due ? new Date(meta.due) : new Date(selectedDay);
    if (!meta.due) due.setHours(17, 0, 0, 0);
    await addTask(USER_ID, {
      title: meta.title,
      tags: meta.tags,
      project: meta.project,
      priority: meta.priority,
      due,
      repeat: meta.repeat,
      area: quickArea,
      reminder: 30,
    });
    setQuick("");
  }

  function onVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert("Speech recognition not supported in this browser."); return; }
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.onstart = () => setVoiceListening(true);
    rec.onend = () => setVoiceListening(false);
    rec.onresult = (e) => {
      const text = Array.from(e.results).map(r => r[0].transcript).join(" ");
      setQuick(text);
      setTimeout(addTaskFromQuick, 50);
    };
    rec.start();
  }

  async function onDragEnd(result) {
    const { destination, draggableId } = result;
    if (!destination) return;
    const dayIndex = parseInt(destination.droppableId.replace("day-", ""), 10);
    const targetDate = weekDays[dayIndex];
    const task = state.tasks.find(t => t.id === draggableId);
    if (!task) return;
    const newDue = new Date(targetDate);
    const oldDue = task.due ? new Date(task.due) : null;
    if (oldDue) newDue.setHours(oldDue.getHours(), oldDue.getMinutes(), 0, 0);
    await updateTask(USER_ID, task.id, { due: newDue });
  }

  const todayStats = useMemo(() => {
    const todayTasks = state.tasks.filter(t => t.due && isToday(new Date(t.due)));
    const completed = todayTasks.filter(t => t.completed).length;
    return { total: todayTasks.length, completed };
  }, [state.tasks]);

  return (
    <div className="min-h-screen bg-[#F4F1EA] text-[#3E3E3B] dark:bg-[#11140F] dark:text-[#ECEBE6]">
      <header className="sticky top-0 z-20 backdrop-blur bg-[#FBF9F3]/60 border-b border-[#E7E2D6]">
        <div className="max-w-6xl mx-auto p-3 flex items-center gap-2">
          <h1 className="text-2xl font-semibold">Today</h1>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => dispatch({ type: "TOGGLE_DARK" })}
              className="px-3 py-1 rounded-xl border border-[#E7E2D6] hover:bg-[#F7F3EA] flex items-center gap-2"
            >
              <span className="hidden sm:inline">Theme</span>
            </button>
            <ImportExport state={state} dispatch={dispatch} />
          </div>
        </div>
      </header>

      {/* Week strip */}
      <div className="max-w-6xl mx-auto px-3 mt-2">
        <div className="mt-2 flex justify-between">
          {weekDays.map((d, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => setSelectedDay(d)}
              className="flex flex-col items-center text-xs focus:outline-none"
            >
              <div className={isSameDay(d, selectedDay) ? "px-3 py-2 rounded-2xl bg-[#9AA27A] text-white" : "px-3 py-2 rounded-2xl text-[#6E6B5E]"}>{format(d,"EEE")}</div>
              <div className="mt-1 text-[#6E6B5E]">{format(d,"d")}</div>
            </button>
          ))}
        </div>
      </div>

      <main className="max-w-6xl mx-auto p-3 grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Left: Capture & Filters */}
        <section className="lg:col-span-2 space-y-3">
          <div className="p-3 rounded-2xl border border-[#E7E2D6] dark:border-[#2A2E25] bg-[#FBF9F3] dark:bg-[#191D16] shadow-sm">
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                value={quick}
                onChange={e => setQuick(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addTaskFromQuick()}
                placeholder='Quick add: "Buy milk tomorrow 5pm #groceries p:Personal !! every monday"'
                className="flex-1 bg-transparent outline-none px-3 py-2 rounded-xl border border-[#E7E2D6]"
              />
              <select
                value={quickArea}
                onChange={e => setQuickArea(e.target.value)}
                className="px-2 py-2 rounded-xl border border-[#E7E2D6] bg-transparent"
              >
                {areas.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
              <button
                onClick={addTaskFromQuick}
                className="px-3 py-2 rounded-xl bg-[#9AA27A] text-white hover:opacity-90 flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />Add
              </button>
              <button
                onClick={onVoice}
                className={`px-3 py-2 rounded-xl border border-[#E7E2D6] dark:border-[#2A2E25] hover:bg-[#F7F3EA] dark:hover:bg-[#20251D] ${voiceListening ? "animate-pulse" : ""}`}
                title="Voice input"
              >
                <Mic className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-[#8E8B80] mt-2">
              Shortcuts: <kbd className="px-1 border rounded">n</kbd> new • <kbd className="px-1 border rounded">/</kbd> search • <kbd className="px-1 border rounded">Shift+D</kbd> theme
            </p>
          </div>

          <div className="p-3 rounded-2xl border border-[#E7E2D6] dark:border-[#2A2E25] bg-[#FBF9F3] dark:bg-[#191D16] shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <Search className="w-4 h-4" />
              <input
                id="search"
                value={query}
                onChange={e=>setQuery(e.target.value)}
                placeholder='Search e.g. tag:urgent AND due:today project:Work priority:High'
                className="flex-1 bg-transparent outline-none px-3 py-2 rounded-xl border border-[#E7E2D6]"
              />
            </div>
            <div className="flex items-center justify-between mt-1 mb-2">
              <div className="text-xl font-medium">To Do List</div>
              <button className="w-8 h-8 rounded-full bg-[#9AA27A] text-white flex items-center justify-center">+</button>
            </div>
            <TaskList tasks={filtered} state={state} />
          </div>
        </section>

        {/* Right: Stats */}
        <section className="space-y-3">
          <div className="p-3 rounded-2xl border border-[#E7E2D6] dark:border-[#2A2E25] bg-[#FBF9F3] dark:bg-[#191D16] shadow-sm">
            <h2 className="font-semibold mb-2">Your streaks & points</h2>
            <div className="flex items-center gap-3 mb-3">
              <CheckCircle2 className="w-5 h-5"/>
              <div className="text-sm">Today: {todayStats.completed}/{todayStats.total} done • Points: <span className="font-semibold">{state.points}</span></div>
            </div>
            <StreakChart history={state.history} />
          </div>

          <div className="p-3 rounded-2xl border border-[#E7E2D6] dark:border-[#2A2E25] bg-[#FBF9F3] dark:bg-[#191D16] shadow-sm">
            <h2 className="font-semibold mb-2">Today's Completion</h2>
            <TodayCompletion total={todayStats.total} completed={todayStats.completed} />
          </div>
        </section>
      </main>

      {/* Full-width Events under To Do List */}
      <section className="max-w-6xl mx-auto p-3">
        <div className="p-3 rounded-2xl border border-[#E7E2D6] dark:border-[#2A2E25] bg-[#FBF9F3] dark:bg-[#191D16] shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-semibold">Events</h2>
            <div className="flex items-center gap-2">
              <button onClick={()=>setAnchorDate(new Date(anchorDate.getTime() - 7*24*60*60*1000))} className="px-2 py-1 rounded-md border border-[#E7E2D6] dark:border-[#2A2E25]">◀</button>
              <input type="date" value={format(anchorDate, "yyyy-MM-dd")} onChange={e=>setAnchorDate(new Date(e.target.value))} className="px-2 py-1 rounded-md border border-[#E7E2D6] dark:border-[#2A2E25] bg-transparent text-sm"/>
              <button onClick={()=>setAnchorDate(new Date(anchorDate.getTime() + 7*24*60*60*1000))} className="px-2 py-1 rounded-md border border-[#E7E2D6] dark:border-[#2A2E25]">▶</button>
            </div>
          </div>
          <DragDropContext onDragEnd={onDragEnd}>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
              {weekDays.map((d, idx) => (
                <Droppable droppableId={`day-${idx}`} key={idx}>
                  {(provided) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                      className="p-3 rounded-xl border border-[#E7E2D6] dark:border-[#2A2E25] bg-[#FBF9F3] dark:bg-[#191D16] min-h-[160px]"
                    >
                      <div className="text-xs text-[#8E8B80] mb-2 font-medium">{format(d, "EEE dd")}</div>
                      {state.tasks
                        .filter(t => t.due && isSameDay(new Date(t.due), d))
                        .sort((a,b)=> new Date(a.due) - new Date(b.due))
                        .map((t, i) => (
                          <Draggable draggableId={t.id} index={i} key={t.id}>
                            {(prov) => (
                              <div
                                ref={prov.innerRef}
                                {...prov.draggableProps}
                                {...prov.dragHandleProps}
                                className={`mb-2 p-2 rounded-lg text-sm ${t.completed ? "line-through opacity-60" : ""} border ${priBorder(t.priority)} bg-[#F7F3EA] dark:bg-[#20251D]`}
                              >
                                {editingId === t.id ? (
                                  <RescheduleInline task={t} onDone={() => setEditingId(null)} />
                                ) : (
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="truncate pr-2">{t.title}</div>
                                    <div className="flex items-center gap-1 shrink-0">
                                      <span className="text-xs text-[#8E8B80]">{t.due ? format(new Date(t.due), "HH:mm") : ""}</span>
                                      <button onClick={() => setEditingId(t.id)} className="px-1.5 py-0.5 rounded-md border border-[#E7E2D6] dark:border-[#2A2E25] text-xs">Edit</button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </Draggable>
                        ))}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
              ))}
            </div>
          </DragDropContext>
        </div>
      </section>

      <footer className="max-w-6xl mx-auto p-6 text-xs text-[#8E8B80]">
        <div className="flex flex-wrap items-center gap-3">
          <span>Collaboration (experimental): share/export JSON to sync.</span>
          <span>ICS: open a task and export .ics to add to Google/Outlook.</span>
          <span>PWA hint: add a service worker in your final build for offline.</span>
        </div>
      </footer>
    </div>
  );
}

function TaskList({ tasks, state }) {
  const [openId, setOpenId] = useState(null);
  const groups = useMemo(() => {
    const byProj = {};
    for (const t of tasks) { const k = t.project || "Inbox"; (byProj[k] ||= []).push(t); }
    return byProj;
  }, [tasks]);

  return (
    <div className="space-y-6">
      {Object.entries(groups).map(([proj, list]) => (
        <div key={proj}>
          <div className="flex items-center gap-2 mb-2 text-sm font-semibold">
            <ChevronRight className="w-4 h-4"/>{proj} <span className="text-xs text-[#8E8B80]">({list.length})</span>
          </div>
          <div className="space-y-2">
            {list
              .sort((a,b)=> (a.completed === b.completed ? 0 : a.completed ? 1 : -1))
              .map(t => (
                <div key={t.id} className={`p-3 rounded-xl border ${priBorder(t.priority)} bg-[#F7F3EA] dark:bg-[#20251D]`}>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={!!t.completed}
                      onChange={() => toggleComplete(USER_ID, t)}
                      className="w-4 h-4"
                    />
                    <div className={`flex-1 ${t.completed ? "line-through opacity-60" : ""}`}>
                      <div className="font-medium">{t.title}</div>
                      <div className="text-xs text-[#8E8B80] dark:text-[#A7A99F] flex flex-wrap gap-2 mt-1">
                        {t.due && <span>🕒 {format(new Date(t.due), "EEE, MMM d HH:mm")}</span>}
                        <span>📌 {t.priority}</span>
                        <span>📁 {t.project}</span>
                        {t.area ? <span>🗂️ {t.area}</span> : null}
                        {t.tags?.length ? <span>🏷️ {t.tags.map(x => `#${x}`).join(" ")}</span> : null}
                        {t.repeat ? <span>🔁 {t.repeat.type}</span> : null}
                      </div>
                    </div>
                    <button onClick={()=>setOpenId(openId===t.id?null:t.id)} className="px-2 py-1 rounded-lg border border-zinc-300 dark:border-zinc-700">
                      <ChevronDown className="w-4 h-4"/>
                    </button>
                    <button
                      onClick={()=>deleteTask(USER_ID, t.id)}
                      className="px-2 py-1 rounded-lg border border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:hover:bg-red-900/20"
                    >
                      <Trash2 className="w-4 h-4"/>
                    </button>
                  </div>
                  {openId === t.id && <TaskEditor task={t} />}
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function TaskEditor({ task }) {
  const [form, setForm] = useState(() => ({
    title: task.title || "",
    notes: task.notes || "",
    project: task.project || "Inbox",
    area: task.area || "Personal",
    priority: task.priority || "Medium",
    tags: (task.tags||[]).join(", "),
    due: task.due ? format(new Date(task.due), "yyyy-MM-dd'T'HH:mm") : "",
    reminder: task.reminder ?? 30,
    repeat: task.repeat?.type || "none",
  }));

  async function save() {
    await updateTask(USER_ID, task.id, {
      title: form.title,
      notes: form.notes,
      project: form.project,
      area: form.area,
      priority: form.priority,
      tags: form.tags.split(",").map(s=>s.trim()).filter(Boolean),
      due: form.due ? new Date(form.due) : null,
      reminder: Number(form.reminder)||0,
      repeat: form.repeat === "none" ? null : { type: form.repeat },
    });
  }

  async function addSubtask() {
    const title = prompt("Subtask title");
    if (!title) return;
    const subtasks = [...(task.subtasks||[]), { id: uid(), title, done: false }];
    await updateTask(USER_ID, task.id, { subtasks });
  }

  async function toggleSub(id) {
    const subtasks = (task.subtasks||[]).map(s => s.id===id?{...s, done:!s.done}:s);
    await updateTask(USER_ID, task.id, { subtasks });
  }

  async function delSub(id) {
    const subtasks = (task.subtasks||[]).filter(s=>s.id!==id);
    await updateTask(USER_ID, task.id, { subtasks });
  }

  function downloadICS() {
    const dt = task.due ? new Date(task.due) : new Date();
    const dtEnd = new Date(dt.getTime() + 60*60*1000);
    const pad = (n)=> String(n).padStart(2,"0");
    const fmt = (d)=> `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
    const ics = [
      "BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Pro To-Do//EN","BEGIN:VEVENT",
      `UID:${task.id}@pro-todo`,`DTSTAMP:${fmt(new Date())}`,
      `DTSTART:${fmt(dt)}`,`DTEND:${fmt(dtEnd)}`,
      `SUMMARY:${(task.title||"").replace(/,/g,"\\,")}`,
      `DESCRIPTION:${(task.notes||"").replace(/\n/g,"\\n")}`,
      "END:VEVENT","END:VCALENDAR"
    ].join("\r\n");
    const blob = new Blob([ics], { type: "text/calendar" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${task.title}.ics`; a.click();
  }

  return (
    <div className="mt-3 p-3 rounded-xl border border-[#E7E2D6] dark:border-[#2A2E25] bg-[#FBF9F3] dark:bg-[#191D16]">
      <div className="grid sm:grid-cols-2 gap-3">
        <L label="Title"><input value={form.title} onChange={e=>setForm({...form, title:e.target.value})} className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent"/></L>
        <L label="Project"><input value={form.project} onChange={e=>setForm({...form, project:e.target.value})} className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent"/></L>
        <L label="Area">
          <select value={form.area} onChange={e=>setForm({...form, area:e.target.value})} className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent">
            {areas.map(a=> <option key={a} value={a}>{a}</option>)}
          </select>
        </L>
        <L label="Priority">
          <select value={form.priority} onChange={e=>setForm({...form, priority:e.target.value})} className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent">
            {priorities.map(p=> <option key={p}>{p}</option>)}
          </select>
        </L>
        <L label="Tags (comma-separated)"><input value={form.tags} onChange={e=>setForm({...form, tags:e.target.value})} className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent"/></L>
        <L label="Due"><input type="datetime-local" value={form.due} onChange={e=>setForm({...form, due:e.target.value})} className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent"/></L>
        <L label="Reminder (minutes before)"><input type="number" value={form.reminder} onChange={e=>setForm({...form, reminder:e.target.value})} className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent"/></L>
        <L label="Repeat">
          <select value={form.repeat} onChange={e=>setForm({...form, repeat:e.target.value})} className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent">
            <option value="none">None</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </L>
        <L label="Notes"><textarea value={form.notes} onChange={e=>setForm({...form, notes:e.target.value})} className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent min-h-[90px]"/></L>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button onClick={save} className="px-3 py-2 rounded-xl bg-[#9AA27A] text-white flex items-center gap-2"><Save className="w-4 h-4"/>Save</button>
        <button onClick={downloadICS} className="px-3 py-2 rounded-xl border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-2"><CalendarIcon className="w-4 h-4"/>Export .ics</button>
        <button onClick={addSubtask} className="px-3 py-2 rounded-xl border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-2"><Plus className="w-4 h-4"/>Add subtask</button>
      </div>

      {task.subtasks?.length ? (
        <div className="mt-3">
          <div className="text-sm font-medium mb-2">Subtasks</div>
          <div className="space-y-2">
            {task.subtasks.map(s => (
              <div key={s.id} className="flex items-center gap-2">
                <input type="checkbox" checked={!!s.done} onChange={()=>toggleSub(s.id)} className="w-4 h-4"/>
                <div className={`flex-1 text-sm ${s.done ? "line-through opacity-60" : ""}`}>{s.title}</div>
                <button onClick={()=>delSub(s.id)} className="px-2 py-1 rounded-lg border border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:hover:bg-red-900/20"><Trash2 className="w-4 h-4"/></button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function L({ label, children }) {
  return (
    <label className="text-sm flex flex-col gap-1">
      <span className="text-[#8E8B80]">{label}</span>
      {children}
    </label>
  );
}

function TodayCompletion({ total, completed }) {
  const pct = total ? Math.round((completed/total)*100) : 0;
  const data = [{ name:"done", value:pct }];
  return (
    <div className="w-full h-48 flex items-center justify-center">
      <ResponsiveContainer width="60%" height="100%">
        <RadialBarChart cx="50%" cy="50%" innerRadius="70%" outerRadius="100%" barSize={16} data={data} startAngle={90} endAngle={90 + (360*pct/100)}>
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
          <RadialBar dataKey="value" cornerRadius={8} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="absolute text-2xl font-semibold">{pct}%</div>
    </div>
  );
}

function RescheduleInline({ task, onDone }) {
  const [dt, setDt] = useState(task.due ? format(new Date(task.due), "yyyy-MM-dd'T'HH:mm") : "");
  async function save() {
    await updateTask(USER_ID, task.id, { due: dt ? new Date(dt) : null });
    onDone?.();
  }
  function snooze(mins) {
    const base = task.due ? new Date(task.due) : new Date();
    const when = new Date(base.getTime() + mins*60*1000);
    setDt(format(when, "yyyy-MM-dd'T'HH:mm"));
  }
  return (
    <div className="space-y-2">
      <input type="datetime-local" value={dt} onChange={(e)=>setDt(e.target.value)} className="w-full px-2 py-1 rounded-md border border-[#E7E2D6] dark:border-[#2A2E25] bg-transparent text-xs"/>
      <div className="flex items-center gap-2 text-xs">
        <span>Quick:</span>
        <button onClick={()=>snooze(60)} className="px-2 py-1 rounded-md border border-[#E7E2D6] dark:border-[#2A2E25]">+1h</button>
        <button onClick={()=>snooze(24*60)} className="px-2 py-1 rounded-md border border-[#E7E2D6] dark:border-[#2A2E25]">+1d</button>
        <button onClick={()=>snooze(7*24*60)} className="px-2 py-1 rounded-md border border-[#E7E2D6] dark:border-[#2A2E25]">Next week</button>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={save} className="px-2 py-1 rounded-md bg-[#9AA27A] text-white">Save</button>
          <button onClick={onDone} className="px-2 py-1 rounded-md border border-[#E7E2D6] dark:border-[#2A2E25]">Cancel</button>
        </div>
      </div>
    </div>
  );
}

function StreakChart({ history }) {
  const data = useMemo(() => {
    const last14 = Array.from({ length: 14 }, (_, i) => {
      const d = dfAddDays(new Date(), -13 + i);
      const key = format(d, "yyyy-MM-dd");
      const rec = history.find(h => h.date === key) || { completed: 0 };
      return { day: format(d, "MMM d"), completed: rec.completed };
    });
    return last14;
  }, [history]);
  return (
    <div className="w-full h-36">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="day" interval={2} fontSize={10} />
          <YAxis allowDecimals={false} fontSize={10} />
          <Tooltip />
          <Line type="monotone" dataKey="completed" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function ImportExport({ state, dispatch }) {
  function exportJSON() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "pro-todo-backup.json"; a.click();
  }
  function importJSON(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        dispatch({ type: "BULK_IMPORT", payload: data });
      } catch { alert("Invalid file"); }
    };
    reader.readAsText(file);
  }
  return (
    <div className="flex items-center gap-2">
      <button onClick={exportJSON} className="px-3 py-1 rounded-xl border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-2">
        <Upload className="w-4 h-4"/>Export
      </button>
      <label className="px-3 py-1 rounded-xl border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer flex items-center gap-2">
        <Save className="w-4 h-4"/>Import
        <input type="file" accept="application/json" onChange={importJSON} className="hidden"/>
      </label>
    </div>
  );
}

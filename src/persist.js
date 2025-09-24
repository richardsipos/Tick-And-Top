// src/persist.js
import { db } from "./persist";
import {
  collection, doc, addDoc, updateDoc, deleteDoc,
  onSnapshot, serverTimestamp, query, orderBy
} from "firebase/firestore";

// if you don't use auth yet, use a fixed doc id
export const USER_ID = "user";

const tasksCol = (uid) => collection(db, "users", uid, "tasks");
const taskDoc  = (uid, id) => doc(db, "users", uid, "tasks", id);

const toJSDate = (v) => (v && typeof v.toDate === "function" ? v.toDate() : v ?? null);

// --- recurrence helper (same logic as in your file) ---
function nextOccurrence(task) {
  const due = task.due ? new Date(task.due) : new Date();
  if (!task.repeat) return null;
  if (task.repeat.type === "daily") return new Date(due.getTime() + 24*60*60*1000);
  if (task.repeat.type === "weekly") {
    if (task.repeat.weekday) {
      const map = { sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6 };
      const target = map[task.repeat.weekday] ?? due.getDay();
      let d = new Date(due);
      do { d = new Date(d.getTime() + 24*60*60*1000); } while (d.getDay() !== target);
      return d;
    }
    return new Date(due.getTime() + 7*24*60*60*1000);
  }
  if (task.repeat.type === "monthly") {
    const d = new Date(due);
    d.setMonth(d.getMonth() + 1);
    return d;
  }
  return null;
}

// --- live listeners ---
export function listenTasks(uid, onChange) {
  const q = query(tasksCol(uid), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snap) => {
    const tasks = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        createdAt: toJSDate(data.createdAt),
        updatedAt: toJSDate(data.updatedAt),
        due: toJSDate(data.due),
      };
    });
    onChange(tasks);
  });
}

// --- CRUD ---
export async function addTask(uid, payload) {
  await addDoc(tasksCol(uid), {
    ...payload,
    completed: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function updateTask(uid, id, patch) {
  await updateDoc(taskDoc(uid, id), {
    ...patch,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteTask(uid, id) {
  await deleteDoc(taskDoc(uid, i2d));
}

export async function toggleComplete(uid, task) {
  const ref = taskDoc(uid, task.id);
  const now = new Date();
  // flip completion
  await updateDoc(ref, {
    completed: !task.completed,
    completedAt: !task.completed ? now : null,
    updatedAt: serverTimestamp(),
  });
  // spawn next recurring
  if (!task.completed && task.repeat) {
    const next = nextOccurrence(task);
    if (next) {
      await addDoc(tasksCol(uid), {
        ...task,
        id: undefined,
        completed: false,
        completedAt: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        due: next,
      });
    }
  }
}

// src/persist.js
import { db } from "./firebase";
import {
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, serverTimestamp, query, orderBy, getDocs, writeBatch
} from "firebase/firestore";

// ---------- Users ----------
export function listenUsers(onChange) {
  const col = collection(db, "users");
  return onSnapshot(col, (snap) => {
    const users = snap.docs
      .filter(d => !["profile", "history", "tasks"].includes(d.id))
      .map(d => ({ id: d.id, name: (d.data() || {}).name || d.id, ...d.data() }));
    onChange(users);
  }, (err) => {
    console.error("listenUsers error:", err);
    alert("Failed to load users: " + err.message);
  });
}

export async function createUser(name) {
  try {
    const base = (name || "Me").trim();
    // make a readable id; fall back to a unique id if slug would be empty
    const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const id = slug || `user-${Date.now()}`;
    await setDoc(doc(db, "users", id), {
      name: base,
      createdAt: serverTimestamp(),
    }, { merge: true });
    return id;
  } catch (e) {
    console.error("createUser error:", e);
    alert("Create user failed: " + e.message);
    throw e;
  }
}

// ---------- Tasks ----------
const tasksCol = (uid) => collection(db, "users", uid, "tasks");
const taskDoc  = (uid, id) => doc(db, "users", uid, "tasks", id);

const toJSDate = (v) => (v && typeof v.toDate === "function" ? v.toDate() : v ?? null);

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
  if (task.repeat.type === "monthly") { const d = new Date(due); d.setMonth(d.getMonth()+1); return d; }
  return null;
}

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
  }, (err) => {
    console.error("listenTasks error:", err);
    alert("Failed to load tasks: " + err.message);
  });
}

export async function addTask(uid, payload) {
  await addDoc(tasksCol(uid), {
    ...payload,
    completed: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function updateTask(uid, id, patch) {
  await updateDoc(taskDoc(uid, id), { ...patch, updatedAt: serverTimestamp() });
}

export async function deleteTask(uid, id) {
  await deleteDoc(taskDoc(uid, id));
}

export async function toggleComplete(uid, task) {
  await updateDoc(taskDoc(uid, task.id), {
    completed: !task.completed,
    completedAt: !task.completed ? new Date() : null,
    updatedAt: serverTimestamp(),
  });
  if (!task.completed && task.repeat) {
    const next = nextOccurrence(task);
    if (next) {
      const { id, createdAt, updatedAt, completedAt, ...rest } = task;
      await addDoc(tasksCol(uid), {
        ...rest,
        completed: false,
        completedAt: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        due: next,
      });
    }
  }
}

// ---------- Delete User & Subcollections ----------
export async function deleteUser(userId) {
  // delete tasks subcollection
  const tasksSnap = await getDocs(collection(db, "users", userId, "tasks"));
  const batch = writeBatch(db);
  tasksSnap.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  // delete user doc
  await deleteDoc(doc(db, "users", userId));
}

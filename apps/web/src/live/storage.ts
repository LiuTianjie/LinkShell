import { createIdentity, type Identity } from "@linkshell/wire";

export function readLocal<T>(key: string, fallback: T): T {
  try {
    return (
      (JSON.parse(
        localStorage.getItem(`linkshell.web.${key}`) ?? "null",
      ) as T) ?? fallback
    );
  } catch {
    return fallback;
  }
}
export function saveLocal(key: string, value: unknown) {
  localStorage.setItem(`linkshell.web.${key}`, JSON.stringify(value));
}

let identityPromise: Promise<Identity> | undefined;
export function browserIdentity(): Promise<Identity> {
  return (identityPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("linkshell.web.identity", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("keys");
    request.onerror = () =>
      reject(new Error("无法保存浏览器设备身份，请允许此网站使用本地存储"));
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("keys", "readwrite");
      const store = tx.objectStore("keys");
      const get = store.get("device");
      let identity: Identity;
      get.onsuccess = () => {
        identity = (get.result as Identity) ?? createIdentity();
        if (!get.result) store.put(identity, "device");
      };
      tx.oncomplete = () => {
        db.close();
        resolve(identity);
      };
      tx.onerror = () => {
        db.close();
        reject(new Error("设备身份保存失败"));
      };
    };
  }));
}

// localStorage への保存。使えない環境(プライベートブラウズなど)でも例外を出さずに動く。

const KEY = 'kakitori-drill.v1';

export function load() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function save(data) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

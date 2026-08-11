const SUPABASE_URL = (env) => String(env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_KEY = (env) => String(env.SUPABASE_SECRET_KEY || "");

function headers(env, extra = {}) {
  const key = SUPABASE_KEY(env);
  return {
    "apikey": key,
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra
  };
}

async function request(env, path, init = {}) {
  const url = `${SUPABASE_URL(env)}/rest/v1/${path}`;
  const response = await fetch(url, {
    ...init,
    headers: headers(env, init.headers || {})
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

export async function insert(env, table, row, options = {}) {
  const prefer = options.returning === false ? "return=minimal" : "return=representation";
  return request(env, table, {
    method: "POST",
    headers: { Prefer: prefer },
    body: JSON.stringify(row)
  });
}

export async function select(env, table, query) {
  return request(env, `${table}?${query}`);
}

export async function update(env, table, query, row) {
  return request(env, `${table}?${query}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row)
  });
}

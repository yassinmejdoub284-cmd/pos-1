// Adaptateur synchrone compatible node:sqlite (prepare().get/all/run, exec) au-dessus
// du SQLite embarqué de l'application Android. Les valeurs sont liées comme Node :
// nombres en REAL (l'affinité INTEGER les convertit), texte, NULL ; booléen et undefined refusés.
function encode(params) {
  for (let i = 0; i < params.length; i++) {
    const v = params[i];
    const t = typeof v;
    if (v === null || t === 'string') continue;
    if (t === 'number') { if (!Number.isFinite(v)) throw new TypeError(`Provided value cannot be bound to SQLite parameter ${i + 1}.`); continue; }
    if (t === 'bigint') { params[i] = Number(v); continue; }
    throw new TypeError(`Provided value cannot be bound to SQLite parameter ${i + 1}.`);
  }
  return JSON.stringify(params);
}

export function nativeDatabase(bridge) {
  const unwrap = raw => {
    const result = JSON.parse(raw);
    if (result.e !== undefined) throw new Error(result.e);
    return result.v;
  };
  const opened = unwrap(bridge.dbOpen());
  return {
    path: opened.path,
    prepare(sql) {
      return {
        get: (...params) => unwrap(bridge.dbQuery(sql, encode(params), 1))[0],
        all: (...params) => unwrap(bridge.dbQuery(sql, encode(params), 0)),
        run: (...params) => unwrap(bridge.dbRun(sql, encode(params))),
      };
    },
    exec(sql) { unwrap(bridge.dbExec(sql)); },
    close() { unwrap(bridge.dbClose()); },
  };
}

export const BUCKET = 'private-album';
export const PHOTO_MAX = 4 * 1024 * 1024;

export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['url','key'].includes(key))) {
    throw new Error('公开配置只能包含 url 和 key 两项；请勿粘贴整块后台配置。');
  }
  if (!raw.url && !raw.key) return null;
  if (typeof raw.url !== 'string' || !/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(raw.url)) {
    throw new Error('项目网址须为 https://项目编号.supabase.co，末尾不带斜线。');
  }
  if (typeof raw.key !== 'string' || raw.key.length > 4096) throw new Error('公开配置不正确。');
  if (/^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(raw.key)) return Object.freeze({ url: raw.url, key: raw.key });
  try {
    const parts = raw.key.split('.');
    if (parts.length !== 3) throw new Error('key');
    const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
    if (payload.role !== 'anon' || payload.ref !== raw.url.split('//')[1].split('.')[0]) throw new Error('role');
    return Object.freeze({ url: raw.url, key: raw.key });
  } catch { throw new Error('这里只能填写项目的 publishable key 或 anon 公钥；禁止管理密钥。'); }
}

export class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}
export class AlbumApi {
  constructor(config) {
    this.config = config;
    this.session = null;
    this.generation = 0;
    this.controllers = new Set();
    this.refreshing = null;
  }
  async request(path, options = {}, { auth = true, refresh = true, binary = false } = {}) {
    const generation = this.generation;
    if (auth && refresh) await this.ensureSession();
    if (generation !== this.generation) throw new DOMException('已结束会话', 'AbortError');
    if (auth && !this.session) throw new ApiError('请重新登录。', 401);
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(new DOMException('请求超时，请检查连接后重试', 'TimeoutError')), options.body instanceof Blob ? 120000 : 30000);
    const headers = { apikey: this.config.key, ...options.headers };
    if (auth) headers.Authorization = `Bearer ${this.session.access_token}`;
    if (options.body && !(options.body instanceof Blob)) headers['Content-Type'] = 'application/json';
    try {
      const response = await fetch(this.config.url + path, {
        ...options, headers, signal: controller.signal, credentials: 'omit',
        cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer'
      });
      if (generation !== this.generation) throw new DOMException('已结束会话', 'AbortError');
      if (!response.ok) {
        if (!auth && path.includes('grant_type=password') && [400,401,422].includes(response.status)) {
          throw new ApiError('邮箱或密码不正确，或后台账号尚未启用。', response.status);
        }
        if (response.status === 401) throw new ApiError('登录已失效，请退出后重新登录；未保存的内容仍留在本页。', 401);
        if (response.status === 403) throw new ApiError('没有操作权限，请核对双人账号配置。', 403);
        if (response.status === 409) throw new ApiError('内容已经变化，请刷新后重试。', 409);
        if (response.status === 413) throw new ApiError('文件超过后台允许的大小。', 413);
        if (response.status === 429) throw new ApiError('操作较频繁，请稍等再试。', 429);
        throw new ApiError(`后台暂未完成操作（${response.status}）。请检查连接或后台配置。`, response.status);
      }
      if (binary) {
        const length = Number(response.headers.get('content-length'));
        if (length > PHOTO_MAX) { controller.abort(); throw new ApiError('图片大小异常，已停止下载。'); }
        const reader = response.body.getReader();
        const chunks = []; let bytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > PHOTO_MAX || generation !== this.generation) {
            await reader.cancel(); throw new ApiError('图片下载已停止。');
          }
          chunks.push(value);
        }
        const type = response.headers.get('content-type')?.split(';')[0];
        if (!['image/jpeg', 'image/webp'].includes(type)) throw new ApiError('图片格式不符合要求。');
        return new Blob(chunks, { type });
      }
      if (response.status === 204) return null;
      const body = await response.text();
      if (generation !== this.generation) throw new DOMException('已结束会话', 'AbortError');
      return body ? JSON.parse(body) : null;
    } finally { clearTimeout(timeout); this.controllers.delete(controller); }
  }
  async login(email, password) {
    this.clear();
    const generation = this.generation;
    const result = await this.request('/auth/v1/token?grant_type=password', {
      method: 'POST', body: JSON.stringify({ email, password })
    }, { auth: false });
    if (generation !== this.generation) throw new DOMException('会话已结束', 'AbortError');
    this.session = { access_token: result.access_token, refresh_token: result.refresh_token,
      expires_at: Date.now() + result.expires_in * 1000, user: result.user };
    try {
      const members = await this.list('album_members', 'select=user_id,label');
      if (members.length !== 2 || !members.some(member => member.user_id === result.user.id)) {
        throw new ApiError('此账号未加入双人画册，请联系管理员。', 403);
      }
      return { user: result.user, members };
    } catch (error) { await this.logout(); throw error; }
  }
  async ensureSession() {
    if (!this.session) return;
    if (this.session.expires_at - Date.now() > 60000) return;
    if (this.refreshing) return this.refreshing;
    const generation = this.generation;
    const token = this.session.refresh_token;
    const promise = (async () => {
      const next = await this.request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', body: JSON.stringify({ refresh_token: token })
      }, { auth: false });
      if (generation !== this.generation) throw new DOMException('会话已结束', 'AbortError');
      this.session = { access_token: next.access_token, refresh_token: next.refresh_token,
        expires_at: Date.now() + next.expires_in * 1000, user: next.user };
    })();
    this.refreshing = promise;
    try { await promise; } finally { if (this.refreshing === promise) this.refreshing = null; }
  }
  clear() {
    this.generation += 1;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear(); this.session = null; this.refreshing = null;
  }
  async logout() {
    const token = this.session?.access_token;
    this.clear();
    if (!token) return;
    // Local state is already cleared; this bounded request only revokes refresh sessions.
    try {
      await fetch(this.config.url + '/auth/v1/logout?scope=local', {
        method: 'POST', headers: { apikey: this.config.key, Authorization: `Bearer ${token}` },
        credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000)
      });
    } catch { /* Logging out locally does not depend on server reachability. */ }
  }
  list(table, query = 'select=*') { return this.request(`/rest/v1/${table}?${query}`); }
  async all(table, order = 'id.asc') {
    const rows = [];
    for (let offset = 0; offset < 10000; offset += 500) {
      const batch = await this.list(table, `select=*&order=${order}&limit=500&offset=${offset}`);
      rows.push(...batch);
      if (batch.length < 500) return rows;
    }
    throw new ApiError('记录超过单次读取上限，请先导出归档，联系管理员分批读取。');
  }
  insert(table, value) { return this.request(`/rest/v1/${table}`, { method: 'POST', body: JSON.stringify(value), headers: { Prefer: 'return=representation' } }); }
  async update(table, id, version, patch) {
    const rows = await this.request(`/rest/v1/${table}?id=eq.${id}&version=eq.${version}`, {
      method: 'PATCH', body: JSON.stringify(patch), headers: { Prefer: 'return=representation' }
    });
    if (!rows?.length) throw new ApiError('这条内容已被另一台设备修改或删除。你的输入还在，请复制后刷新重新编辑。', 409);
    return rows[0];
  }
  async remove(table, id, version) {
    const rows = await this.request(`/rest/v1/${table}?id=eq.${id}${version ? `&version=eq.${version}` : ''}`, {
      method: 'DELETE', headers: { Prefer: 'return=representation' }
    });
    if (!rows?.length) throw new ApiError('删除未确认：内容可能已变更，请刷新后检查。', 409);
  }
  upload(path, blob) { return this.request(`/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST', body: blob, headers: { 'Content-Type': blob.type, 'x-upsert': 'false', 'cache-control': '0' }
  }); }
  download(path) { return this.request(`/storage/v1/object/authenticated/${BUCKET}/${path}`, {}, { binary: true }); }
  deleteObjects(paths) { return this.request(`/storage/v1/object/${BUCKET}`, { method: 'DELETE', body: JSON.stringify({ prefixes: paths }) }); }
  async listObjects(entry) {
    const prefix = `${entry.owner_id}/${entry.id}`;
    const all = [];
    for (let offset = 0; offset < 2000; offset += 100) {
      const batch = await this.request(`/storage/v1/object/list/${BUCKET}`, {
        method: 'POST', body: JSON.stringify({ prefix, limit: 100, offset, sortBy: { column: 'name', order: 'asc' } })
      });
      for (const row of batch) if (row.id) all.push(`${prefix}/${row.name}`);
      if (batch.length < 100) return all;
    }
    throw new ApiError('图片数量过多，未完成清理，请联系管理员。');
  }
}

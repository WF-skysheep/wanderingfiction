let wfSchemaReady = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env, true) });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return json(request, env, { ok: true, service: 'deepseek-worker-backend' }, 200);
    }

    if (request.method === 'GET' && url.pathname === '/api/netease/random-song') {
      return handleNeteaseRandomSong(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/netease/profile') {
      return handleNeteaseProfile(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/translate') {
      return handleTranslate(request, env);
    }

    if (url.pathname.startsWith('/wf/api/')) {
      return handleWfApi(request, env, url);
    }

    return json(request, env, { error: 'Not Found' }, 404);
  }
};

async function handleWfApi(request, env, url) {
  if (!env.WF_DB) {
    return json(request, env, { error: 'Missing D1 binding: WF_DB' }, 500);
  }

  await ensureWfSchema(env.WF_DB);
  await cleanupReadMessages(env.WF_DB);

  const user = await getSessionUser(request, env.WF_DB);
  const method = request.method;
  const path = url.pathname;

  if (method === 'GET' && path === '/wf/api/health') {
    return json(request, env, { ok: true, service: 'wf-worker-backend' }, 200);
  }

  if (method === 'POST' && path === '/wf/api/auth/register') {
    return wfRegister(request, env);
  }
  if (method === 'POST' && path === '/wf/api/auth/login') {
    return wfLogin(request, env);
  }
  if (method === 'POST' && path === '/wf/api/auth/logout') {
    if (!user) return json(request, env, { error: '请先登录' }, 401);
    return wfLogout(request, env, user);
  }
  if (method === 'GET' && path === '/wf/api/auth/me') {
    if (!user) return json(request, env, { loggedIn: false }, 200);
    const unread = await scalarInt(env.WF_DB, 'SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND is_read = 0', [user.id]);
    return json(request, env, { loggedIn: true, user, unreadCount: unread }, 200);
  }

  if (method === 'POST' && path === '/wf/api/ai/opening') {
    if (!user) return json(request, env, { error: '请先登录' }, 401);
    const body = await request.json().catch(() => null);
    const name = String(body?.name || '').trim() || '流浪小说';
    const opening = await generateOpening(env, name);
    return json(request, env, { opening, provider: normalizeAiProvider(env) }, 200);
  }

  if (method === 'GET' && path === '/wf/api/projects') {
    if (!user) return json(request, env, { error: '请先登录' }, 401);
    return wfListProjects(request, env, user);
  }

  if (method === 'POST' && path === '/wf/api/projects') {
    if (!user) return json(request, env, { error: '请先登录' }, 401);
    return wfCreateProject(request, env, user);
  }

  const claimMatch = path.match(/^\/wf\/api\/projects\/([^/]+)\/claim$/);
  if (method === 'POST' && claimMatch) {
    if (!user) return json(request, env, { error: '请先登录' }, 401);
    return wfClaimProject(request, env, user, claimMatch[1]);
  }

  const continueMatch = path.match(/^\/wf\/api\/projects\/([^/]+)\/continue$/);
  if (method === 'POST' && continueMatch) {
    if (!user) return json(request, env, { error: '请先登录' }, 401);
    return wfContinueProject(request, env, user, continueMatch[1]);
  }

  const completeMatch = path.match(/^\/wf\/api\/projects\/([^/]+)\/complete$/);
  if (method === 'POST' && completeMatch) {
    if (!user) return json(request, env, { error: '请先登录' }, 401);
    return wfCompleteProject(request, env, user, completeMatch[1]);
  }

  const reopenMatch = path.match(/^\/wf\/api\/projects\/([^/]+)\/reopen$/);
  if (method === 'POST' && reopenMatch) {
    if (!user) return json(request, env, { error: '请先登录' }, 401);
    if (user.role !== 'admin') return json(request, env, { error: '仅管理员可操作' }, 403);
    return wfReopenProject(request, env, user, reopenMatch[1]);
  }

  const delProjectMatch = path.match(/^\/wf\/api\/projects\/([^/]+)$/);
  if (method === 'DELETE' && delProjectMatch) {
    if (!user) return json(request, env, { error: '请先登录' }, 401);
    return wfDeleteProject(request, env, user, delProjectMatch[1]);
  }

  const exportMatch = path.match(/^\/wf\/api\/projects\/([^/]+)\/export\.txt$/);
  if (method === 'GET' && exportMatch) {
    if (!user) return json(request, env, { error: '请先登录' }, 401);
    if (user.role !== 'admin') return json(request, env, { error: '仅管理员可操作' }, 403);
    return wfExportProjectTxt(request, env, exportMatch[1]);
  }

  const delLineMatch = path.match(/^\/wf\/api\/continuations\/([^/]+)$/);
  if (method === 'DELETE' && delLineMatch) {
    if (!user) return json(request, env, { error: '请先登录' }, 401);
    return wfDeleteContinuation(request, env, user, delLineMatch[1]);
  }

  if (method === 'GET' && path === '/wf/api/messages/unread-count') {
    if (!user) return json(request, env, { error: '请先登录' }, 401);
    const unread = await scalarInt(env.WF_DB, 'SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND is_read = 0', [user.id]);
    return json(request, env, { unreadCount: unread }, 200);
  }

  if (method === 'GET' && path === '/wf/api/messages') {
    if (!user) return json(request, env, { error: '请先登录' }, 401);
    const rows = await allRows(
      env.WF_DB,
      `SELECT m.id, m.content, m.is_read, m.created_at, m.read_at, u.username AS from_admin_name
       FROM messages m
       LEFT JOIN users u ON u.id = m.from_admin_id
       WHERE m.user_id = ?
       ORDER BY m.created_at DESC`,
      [user.id]
    );
    return json(request, env, {
      messages: rows.map((x) => ({
        id: x.id,
        content: x.content,
        isRead: Number(x.is_read) === 1,
        createdAt: x.created_at,
        readAt: x.read_at,
        fromAdminName: x.from_admin_name || '系统管理员'
      }))
    }, 200);
  }

  if (method === 'POST' && path === '/wf/api/messages/mark-all-read') {
    if (!user) return json(request, env, { error: '请先登录' }, 401);
    await env.WF_DB.prepare('UPDATE messages SET is_read = 1, read_at = ? WHERE user_id = ? AND is_read = 0')
      .bind(nowSql(), user.id)
      .run();
    return json(request, env, { ok: true }, 200);
  }

  if (method === 'GET' && path === '/wf/api/admin/users') {
    if (!user) return json(request, env, { error: '请先登录' }, 401);
    if (user.role !== 'admin') return json(request, env, { error: '仅管理员可操作' }, 403);
    const users = await allRows(
      env.WF_DB,
      `SELECT u.id, u.username, u.role, u.created_at,
              (SELECT COUNT(*) FROM projects p WHERE p.creator_id = u.id) AS project_count
       FROM users u
       WHERE u.deleted_at IS NULL
       ORDER BY u.created_at DESC`
    );
    return json(request, env, { users }, 200);
  }

  if (method === 'GET' && path === '/wf/api/admin/projects') {
    if (!user) return json(request, env, { error: '请先登录' }, 401);
    if (user.role !== 'admin') return json(request, env, { error: '仅管理员可操作' }, 403);
    const projects = await allRows(
      env.WF_DB,
      `SELECT p.id, p.name, p.status, p.created_at, p.updated_at, u.username AS creator_name
       FROM projects p
       LEFT JOIN users u ON u.id = p.creator_id
       ORDER BY p.updated_at DESC`
    );
    return json(request, env, { projects }, 200);
  }

  if (method === 'POST' && path === '/wf/api/admin/messages') {
    if (!user) return json(request, env, { error: '请先登录' }, 401);
    if (user.role !== 'admin') return json(request, env, { error: '仅管理员可操作' }, 403);
    return wfAdminSendMessage(request, env, user);
  }

  const adminDeleteUserMatch = path.match(/^\/wf\/api\/admin\/users\/([^/]+)$/);
  if (method === 'DELETE' && adminDeleteUserMatch) {
    if (!user) return json(request, env, { error: '请先登录' }, 401);
    if (user.role !== 'admin') return json(request, env, { error: '仅管理员可操作' }, 403);
    return wfAdminDeleteUser(request, env, user, adminDeleteUserMatch[1]);
  }

  const adminDeleteProjectMatch = path.match(/^\/wf\/api\/admin\/projects\/([^/]+)$/);
  if (method === 'DELETE' && adminDeleteProjectMatch) {
    if (!user) return json(request, env, { error: '请先登录' }, 401);
    if (user.role !== 'admin') return json(request, env, { error: '仅管理员可操作' }, 403);
    return wfAdminDeleteProject(request, env, user, adminDeleteProjectMatch[1]);
  }

  const adminCompleteProjectMatch = path.match(/^\/wf\/api\/admin\/projects\/([^/]+)\/complete$/);
  if (method === 'POST' && adminCompleteProjectMatch) {
    if (!user) return json(request, env, { error: '请先登录' }, 401);
    if (user.role !== 'admin') return json(request, env, { error: '仅管理员可操作' }, 403);
    return wfAdminCompleteProject(request, env, user, adminCompleteProjectMatch[1]);
  }

  const adminReopenProjectMatch = path.match(/^\/wf\/api\/admin\/projects\/([^/]+)\/reopen$/);
  if (method === 'POST' && adminReopenProjectMatch) {
    if (!user) return json(request, env, { error: '请先登录' }, 401);
    if (user.role !== 'admin') return json(request, env, { error: '仅管理员可操作' }, 403);
    return wfAdminReopenProject(request, env, user, adminReopenProjectMatch[1]);
  }

  if (method === 'GET' && path === '/wf/api/admin/audit-logs') {
    if (!user) return json(request, env, { error: '请先登录' }, 401);
    if (user.role !== 'admin') return json(request, env, { error: '仅管理员可操作' }, 403);
    const logs = await allRows(env.WF_DB, 'SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200');
    return json(request, env, { logs }, 200);
  }

  return json(request, env, { error: 'Not Found' }, 404);
}

async function wfRegister(request, env) {
  const body = await request.json().catch(() => null);
  const username = String(body?.username || '').trim();
  const password = String(body?.password || '');

  if (!username || username.length < 2) {
    return json(request, env, { error: '用户名至少 2 个字符' }, 400);
  }
  if (password.length < 6) {
    return json(request, env, { error: '密码至少 6 位' }, 400);
  }

  const existed = await firstRow(env.WF_DB, 'SELECT id FROM users WHERE username = ? AND deleted_at IS NULL', [username]);
  if (existed) {
    return json(request, env, { error: '用户名已存在' }, 409);
  }

  const role = username === String(env.WF_ADMIN_USERNAME || 'admin') ? 'admin' : 'user';
  const passwordHash = await hashPassword(password);
  await env.WF_DB.prepare(
    'INSERT INTO users (id, username, password_hash, role, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, NULL)'
  ).bind(crypto.randomUUID(), username, passwordHash, role, nowSql()).run();

  return json(request, env, { ok: true, role }, 200);
}

async function wfLogin(request, env) {
  const body = await request.json().catch(() => null);
  const username = String(body?.username || '').trim();
  const password = String(body?.password || '');

  const user = await firstRow(
    env.WF_DB,
    'SELECT id, username, role, password_hash FROM users WHERE username = ? AND deleted_at IS NULL',
    [username]
  );
  if (!user) return json(request, env, { error: '用户名或密码错误' }, 401);

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return json(request, env, { error: '用户名或密码错误' }, 401);

  const sid = crypto.randomUUID();
  await env.WF_DB.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(sid, user.id, nowSql(), plusDaysSql(14))
    .run();

  const headers = {
    'Set-Cookie': makeSessionCookie(sid, 14 * 24 * 60 * 60)
  };

  return json(request, env, { ok: true, user: { id: user.id, username: user.username, role: user.role } }, 200, headers);
}

async function wfLogout(request, env, user) {
  const sid = parseCookies(request.headers.get('Cookie') || '').wf_sid;
  if (sid) {
    await env.WF_DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
  }
  return json(request, env, { ok: true, userId: user.id }, 200, {
    'Set-Cookie': 'wf_sid=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0'
  });
}

async function wfCreateProject(request, env, user) {
  const body = await request.json().catch(() => null);
  const name = String(body?.name || '').trim();
  const openingMode = String(body?.openingMode || '').trim();
  const openingText = String(body?.openingText || '').trim();

  if (!name) return json(request, env, { error: '项目名不能为空' }, 400);
  if (openingMode !== 'ai' && openingMode !== 'manual') {
    return json(request, env, { error: 'openingMode 必须是 ai 或 manual' }, 400);
  }

  let opening = openingText;
  if (openingMode === 'ai') {
    opening = await generateOpening(env, name);
  }
  if (!String(opening || '').trim()) {
    return json(request, env, { error: '开头内容不能为空' }, 400);
  }

  const projectId = crypto.randomUUID();
  const ts = nowSql();
  await env.WF_DB.batch([
    env.WF_DB.prepare(
      `INSERT INTO projects (id, name, status, creator_id, current_writer_id, lock_version, created_at, updated_at)
       VALUES (?, ?, 'in_progress', ?, NULL, 0, ?, ?)`
    ).bind(projectId, name, user.id, ts, ts),
    env.WF_DB.prepare(
      'INSERT INTO continuations (id, project_id, author_id, content, seq, created_at) VALUES (?, ?, ?, ?, 1, ?)'
    ).bind(crypto.randomUUID(), projectId, user.id, String(opening).trim(), ts)
  ]);

  return json(request, env, { ok: true, projectId, opening: String(opening).trim() }, 200);
}

async function wfListProjects(request, env) {
  const projects = await allRows(
    env.WF_DB,
    `SELECT p.id, p.name, p.status, p.creator_id, p.current_writer_id, p.created_at, p.updated_at,
            cu.username AS creator_name, wu.username AS writer_name
     FROM projects p
     LEFT JOIN users cu ON cu.id = p.creator_id
     LEFT JOIN users wu ON wu.id = p.current_writer_id
     ORDER BY p.updated_at DESC`
  );
  const lines = await allRows(
    env.WF_DB,
    `SELECT c.id, c.project_id, c.author_id, c.content, c.seq, c.created_at, u.username AS author_name
     FROM continuations c
     LEFT JOIN users u ON u.id = c.author_id
     ORDER BY c.project_id, c.seq ASC`
  );

  const bucket = new Map();
  for (const line of lines) {
    if (!bucket.has(line.project_id)) bucket.set(line.project_id, []);
    bucket.get(line.project_id).push({
      id: line.id,
      authorId: line.author_id,
      authorName: line.author_name || '已删除用户',
      content: line.content,
      seq: line.seq,
      createdAt: line.created_at
    });
  }

  return json(request, env, {
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      creatorId: p.creator_id,
      creatorName: p.creator_name || '已删除用户',
      currentWriterId: p.current_writer_id,
      currentWriterName: p.writer_name || null,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      continuations: bucket.get(p.id) || []
    }))
  }, 200);
}

async function wfClaimProject(request, env, user, projectId) {
  const project = await firstRow(env.WF_DB, 'SELECT id, status, current_writer_id FROM projects WHERE id = ?', [projectId]);
  if (!project) return json(request, env, { error: '项目不存在' }, 404);
  if (project.status === 'completed') return json(request, env, { error: '项目已完成，不可续写' }, 409);

  const r = await env.WF_DB.prepare(
    `UPDATE projects
     SET current_writer_id = ?, lock_version = lock_version + 1, updated_at = ?
     WHERE id = ? AND status = 'in_progress' AND (current_writer_id IS NULL OR current_writer_id = ?)`
  ).bind(user.id, nowSql(), projectId, user.id).run();

  if ((r.meta?.changes || 0) === 0) {
    return json(request, env, { error: '当前已有其他用户持有续写权' }, 409);
  }

  return json(request, env, { ok: true }, 200);
}

async function wfContinueProject(request, env, user, projectId) {
  const body = await request.json().catch(() => null);
  const content = String(body?.content || '').trim();

  const project = await firstRow(env.WF_DB, 'SELECT id, status, current_writer_id FROM projects WHERE id = ?', [projectId]);
  if (!project) return json(request, env, { error: '项目不存在' }, 404);
  if (project.status === 'completed') return json(request, env, { error: '项目已完成，不可续写' }, 409);
  if (project.current_writer_id !== user.id) return json(request, env, { error: '你未持有续写权' }, 409);

  if (content) {
    const nextSeq = (await scalarInt(env.WF_DB, 'SELECT COALESCE(MAX(seq), 0) + 1 AS c FROM continuations WHERE project_id = ?', [projectId]));
    await env.WF_DB.prepare(
      'INSERT INTO continuations (id, project_id, author_id, content, seq, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(crypto.randomUUID(), projectId, user.id, content, nextSeq, nowSql()).run();
  }

  await env.WF_DB.prepare(
    'UPDATE projects SET current_writer_id = NULL, lock_version = lock_version + 1, updated_at = ? WHERE id = ? AND current_writer_id = ?'
  ).bind(nowSql(), projectId, user.id).run();

  return json(request, env, { ok: true, addedContent: Boolean(content) }, 200);
}

async function wfCompleteProject(request, env, user, projectId) {
  const project = await firstRow(env.WF_DB, 'SELECT id, creator_id FROM projects WHERE id = ?', [projectId]);
  if (!project) return json(request, env, { error: '项目不存在' }, 404);

  const can = user.role === 'admin' || project.creator_id === user.id;
  if (!can) return json(request, env, { error: '仅创建者或管理员可完成项目' }, 403);

  await env.WF_DB.prepare('UPDATE projects SET status = ?, current_writer_id = NULL, updated_at = ? WHERE id = ?')
    .bind('completed', nowSql(), projectId)
    .run();

  if (user.role === 'admin') {
    await audit(env.WF_DB, user.id, 'force_complete_project', 'project', projectId, {});
    await notify(env.WF_DB, project.creator_id, user.id, '管理员已强制完成你的流浪小说项目。');
  }

  return json(request, env, { ok: true }, 200);
}

async function wfReopenProject(request, env, user, projectId) {
  const project = await firstRow(env.WF_DB, 'SELECT id, creator_id FROM projects WHERE id = ?', [projectId]);
  if (!project) return json(request, env, { error: '项目不存在' }, 404);

  await env.WF_DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?')
    .bind('in_progress', nowSql(), projectId)
    .run();
  await audit(env.WF_DB, user.id, 'reopen_project', 'project', projectId, {});
  await notify(env.WF_DB, project.creator_id, user.id, '管理员已将你的项目重新开放续写。');

  return json(request, env, { ok: true }, 200);
}

async function wfDeleteProject(request, env, user, projectId) {
  const project = await firstRow(env.WF_DB, 'SELECT id, creator_id FROM projects WHERE id = ?', [projectId]);
  if (!project) return json(request, env, { error: '项目不存在' }, 404);

  if (user.role !== 'admin' && project.creator_id !== user.id) {
    return json(request, env, { error: '普通用户只能删除自己创建的项目' }, 403);
  }

  await env.WF_DB.prepare('DELETE FROM projects WHERE id = ?').bind(projectId).run();

  if (user.role === 'admin') {
    await audit(env.WF_DB, user.id, 'force_delete_project', 'project', projectId, {});
    await notify(env.WF_DB, project.creator_id, user.id, '管理员已删除你的流浪小说项目。');
  }

  return json(request, env, { ok: true }, 200);
}

async function wfDeleteContinuation(request, env, user, continuationId) {
  const line = await firstRow(
    env.WF_DB,
    'SELECT id, project_id, author_id FROM continuations WHERE id = ?',
    [continuationId]
  );
  if (!line) return json(request, env, { error: '续写不存在' }, 404);

  if (user.role === 'admin') {
    await env.WF_DB.prepare('DELETE FROM continuations WHERE id = ?').bind(continuationId).run();
    await audit(env.WF_DB, user.id, 'delete_any_continuation', 'continuation', continuationId, { projectId: line.project_id });
    return json(request, env, { ok: true }, 200);
  }

  if (line.author_id !== user.id) return json(request, env, { error: '只能删除自己的续写' }, 403);

  const latest = await firstRow(
    env.WF_DB,
    'SELECT id FROM continuations WHERE project_id = ? ORDER BY seq DESC LIMIT 1',
    [line.project_id]
  );
  if (!latest || latest.id !== continuationId) {
    return json(request, env, { error: '该续写已被后续覆盖，不能删除' }, 409);
  }

  await env.WF_DB.prepare('DELETE FROM continuations WHERE id = ?').bind(continuationId).run();
  return json(request, env, { ok: true }, 200);
}

async function wfAdminSendMessage(request, env, adminUser) {
  const body = await request.json().catch(() => null);
  const toUserId = String(body?.toUserId || '').trim();
  const content = String(body?.content || '').trim();

  if (!toUserId) return json(request, env, { error: 'toUserId 不能为空' }, 400);
  if (!content) return json(request, env, { error: '消息内容不能为空' }, 400);

  const user = await firstRow(env.WF_DB, 'SELECT id FROM users WHERE id = ? AND deleted_at IS NULL', [toUserId]);
  if (!user) return json(request, env, { error: '用户不存在' }, 404);

  await env.WF_DB.prepare(
    'INSERT INTO messages (id, user_id, from_admin_id, content, is_read, created_at, read_at) VALUES (?, ?, ?, ?, 0, ?, NULL)'
  ).bind(crypto.randomUUID(), toUserId, adminUser.id, content, nowSql()).run();

  await audit(env.WF_DB, adminUser.id, 'send_message', 'user', toUserId, { content });

  return json(request, env, { ok: true }, 200);
}

async function wfAdminDeleteUser(request, env, adminUser, userId) {
  const target = await firstRow(env.WF_DB, 'SELECT id, role, username FROM users WHERE id = ? AND deleted_at IS NULL', [userId]);
  if (!target) return json(request, env, { error: '用户不存在' }, 404);
  if (target.role === 'admin') return json(request, env, { error: '不能删除管理员账号' }, 400);

  await env.WF_DB.batch([
    env.WF_DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    env.WF_DB.prepare('UPDATE projects SET creator_id = NULL WHERE creator_id = ?').bind(userId),
    env.WF_DB.prepare('UPDATE projects SET current_writer_id = NULL WHERE current_writer_id = ?').bind(userId),
    env.WF_DB.prepare('UPDATE continuations SET author_id = NULL WHERE author_id = ?').bind(userId),
    env.WF_DB.prepare('DELETE FROM messages WHERE user_id = ?').bind(userId),
    env.WF_DB.prepare('UPDATE messages SET from_admin_id = NULL WHERE from_admin_id = ?').bind(userId),
    env.WF_DB.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').bind(nowSql(), userId)
  ]);

  await audit(env.WF_DB, adminUser.id, 'delete_user', 'user', userId, { username: target.username, strategy: 'soft_delete' });
  return json(request, env, { ok: true }, 200);
}

async function wfAdminDeleteProject(request, env, adminUser, projectId) {
  const project = await firstRow(env.WF_DB, 'SELECT id, creator_id FROM projects WHERE id = ?', [projectId]);
  if (!project) return json(request, env, { error: '项目不存在' }, 404);

  await env.WF_DB.prepare('DELETE FROM projects WHERE id = ?').bind(projectId).run();
  await audit(env.WF_DB, adminUser.id, 'force_delete_project', 'project', projectId, {});
  await notify(env.WF_DB, project.creator_id, adminUser.id, '管理员已强制删除你的项目。');

  return json(request, env, { ok: true }, 200);
}

async function wfAdminCompleteProject(request, env, adminUser, projectId) {
  const project = await firstRow(env.WF_DB, 'SELECT id, creator_id FROM projects WHERE id = ?', [projectId]);
  if (!project) return json(request, env, { error: '项目不存在' }, 404);

  await env.WF_DB.prepare('UPDATE projects SET status = ?, current_writer_id = NULL, updated_at = ? WHERE id = ?')
    .bind('completed', nowSql(), projectId)
    .run();
  await audit(env.WF_DB, adminUser.id, 'force_complete_project', 'project', projectId, {});
  await notify(env.WF_DB, project.creator_id, adminUser.id, '管理员已强制完成你的项目。');

  return json(request, env, { ok: true }, 200);
}

async function wfAdminReopenProject(request, env, adminUser, projectId) {
  const project = await firstRow(env.WF_DB, 'SELECT id, creator_id FROM projects WHERE id = ?', [projectId]);
  if (!project) return json(request, env, { error: '项目不存在' }, 404);

  await env.WF_DB.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?')
    .bind('in_progress', nowSql(), projectId)
    .run();
  await audit(env.WF_DB, adminUser.id, 'reopen_project', 'project', projectId, {});
  await notify(env.WF_DB, project.creator_id, adminUser.id, '管理员已将你的项目重新开放。');

  return json(request, env, { ok: true }, 200);
}

async function wfExportProjectTxt(request, env, projectId) {
  const project = await firstRow(
    env.WF_DB,
    `SELECT p.id, p.name, p.status, p.created_at, u.username AS creator_name
     FROM projects p
     LEFT JOIN users u ON u.id = p.creator_id
     WHERE p.id = ?`,
    [projectId]
  );
  if (!project) return json(request, env, { error: '项目不存在' }, 404);

  const lines = await allRows(
    env.WF_DB,
    `SELECT c.content, c.created_at, u.username AS author_name
     FROM continuations c
     LEFT JOIN users u ON u.id = c.author_id
     WHERE c.project_id = ?
     ORDER BY c.seq ASC`,
    [projectId]
  );

  const rows = [];
  rows.push('项目名: ' + project.name);
  rows.push('状态: ' + project.status);
  rows.push('创建者: ' + (project.creator_name || '已删除用户'));
  rows.push('创建时间: ' + project.created_at);
  rows.push('');
  rows.push('续写内容:');
  lines.forEach((line, i) => {
    rows.push('[' + (i + 1) + '] 作者: ' + (line.author_name || '已删除用户'));
    rows.push('时间: ' + line.created_at);
    rows.push('内容: ' + line.content);
    rows.push('');
  });

  return new Response(rows.join('\n'), {
    status: 200,
    headers: {
      ...corsHeaders(request, env, true),
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(project.name + '.txt')
    }
  });
}

async function getSessionUser(request, db) {
  const sid = parseCookies(request.headers.get('Cookie') || '').wf_sid;
  if (!sid) return null;

  const row = await firstRow(
    db,
    `SELECT s.id, s.user_id, s.expires_at, u.username, u.role
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND u.deleted_at IS NULL`,
    [sid]
  );
  if (!row) return null;

  if (row.expires_at < nowSql()) {
    await db.prepare('DELETE FROM sessions WHERE id = ?').bind(row.id).run();
    return null;
  }

  return { id: row.user_id, username: row.username, role: row.role };
}

async function cleanupReadMessages(db) {
  const threshold = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  await db.prepare('DELETE FROM messages WHERE is_read = 1 AND read_at IS NOT NULL AND read_at < ?').bind(threshold).run();
}

async function audit(db, adminId, action, targetType, targetId, details) {
  await db.prepare(
    'INSERT INTO audit_logs (id, admin_id, action, target_type, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), adminId || null, action, targetType, targetId || null, JSON.stringify(details || {}), nowSql()).run();
}

async function notify(db, userId, fromAdminId, content) {
  if (!userId) return;
  await db.prepare(
    'INSERT INTO messages (id, user_id, from_admin_id, content, is_read, created_at, read_at) VALUES (?, ?, ?, ?, 0, ?, NULL)'
  ).bind(crypto.randomUUID(), userId, fromAdminId || null, content, nowSql()).run();
}

async function generateOpening(env, projectName) {
  const name = String(projectName || '').trim() || '流浪小说';
  const provider = normalizeAiProvider(env);
  try {
    if (provider === 'deepseek' && env.DEEPSEEK_API_KEY) {
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + env.DEEPSEEK_API_KEY
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          temperature: 0.9,
          messages: [
            { role: 'system', content: '你是小说写作助手。' },
            { role: 'user', content: '请生成一个中文小说开头，80-160字，题目主题为“' + name + '”，只输出正文。' }
          ]
        })
      });
      const data = await res.json().catch(() => null);
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (res.ok && text) return text;
    }

    if (provider === 'openai' && env.OPENAI_API_KEY) {
      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + env.OPENAI_API_KEY
        },
        body: JSON.stringify({
          model: 'gpt-4.1-mini',
          input: [
            { role: 'system', content: '你是小说写作助手。' },
            { role: 'user', content: '请生成一个中文小说开头，80-160字，题目主题为“' + name + '”，只输出正文。' }
          ],
          max_output_tokens: 220
        })
      });
      const data = await res.json().catch(() => null);
      const text = data?.output_text?.trim();
      if (res.ok && text) return text;
    }
  } catch (_) {}

  const seeds = [
    '雨夜里，' + name + ' 的第一盏灯突然亮起。',
    '没有人知道 ' + name + ' 从哪一天开始被传颂。',
    name + ' 的故事，要从一封未署名的信说起。',
    '当城市最后一班车离站时，' + name + ' 才真正开始。'
  ];
  return seeds[Math.floor(Math.random() * seeds.length)];
}

function normalizeAiProvider(env) {
  return String(env.WF_AI_PROVIDER || 'mock').trim().toLowerCase();
}

async function firstRow(db, sql, args = []) {
  const row = await db.prepare(sql).bind(...args).first();
  return row || null;
}

async function allRows(db, sql, args = []) {
  const res = await db.prepare(sql).bind(...args).all();
  return Array.isArray(res?.results) ? res.results : [];
}

async function scalarInt(db, sql, args = []) {
  const row = await firstRow(db, sql, args);
  if (!row) return 0;
  const key = Object.keys(row)[0];
  return Number(row[key] || 0);
}

function parseCookies(cookieHeader) {
  const out = {};
  for (const raw of cookieHeader.split(';')) {
    const part = raw.trim();
    if (!part) continue;
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function makeSessionCookie(sid, maxAgeSec) {
  return [
    'wf_sid=' + encodeURIComponent(sid),
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=None',
    'Max-Age=' + String(maxAgeSec)
  ].join('; ');
}

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function plusDaysSql(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 120000;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return 'pbkdf2$' + iterations + '$' + base64(salt) + '$' + base64(new Uint8Array(bits));
}

async function verifyPassword(password, packed) {
  const parts = String(packed || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  const salt = base64ToBytes(parts[2]);
  const expect = base64ToBytes(parts[3]);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  const got = new Uint8Array(bits);
  if (got.length !== expect.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i += 1) diff |= got[i] ^ expect[i];
  return diff === 0;
}

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToBytes(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function ensureWfSchema(db) {
  if (wfSchemaReady) {
    await wfSchemaReady;
    return;
  }
  wfSchemaReady = (async () => {
    await db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress',
  creator_id TEXT,
  current_writer_id TEXT,
  lock_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS continuations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  author_id TEXT,
  content TEXT NOT NULL,
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, seq)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  from_admin_id TEXT,
  content TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  admin_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  details TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_projects_creator ON projects(creator_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_continuations_project_seq ON continuations(project_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_read_gc ON messages(is_read, read_at);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
    `);

    // Backward-compatible schema repair for previously created partial tables.
    await ensureColumn(db, 'users', 'role', "role TEXT NOT NULL DEFAULT 'user'");
    await ensureColumn(db, 'users', 'created_at', "created_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00'");
    await ensureColumn(db, 'users', 'deleted_at', 'deleted_at TEXT');

    await ensureColumn(db, 'sessions', 'user_id', 'user_id TEXT');
    await ensureColumn(db, 'sessions', 'created_at', "created_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00'");
    await ensureColumn(db, 'sessions', 'expires_at', "expires_at TEXT NOT NULL DEFAULT '2999-12-31 23:59:59'");

    await ensureColumn(db, 'projects', 'creator_id', 'creator_id TEXT');
    await ensureColumn(db, 'projects', 'current_writer_id', 'current_writer_id TEXT');
    await ensureColumn(db, 'projects', 'lock_version', 'lock_version INTEGER NOT NULL DEFAULT 0');
    await ensureColumn(db, 'projects', 'created_at', "created_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00'");
    await ensureColumn(db, 'projects', 'updated_at', "updated_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00'");

    await ensureColumn(db, 'continuations', 'author_id', 'author_id TEXT');
    await ensureColumn(db, 'continuations', 'seq', 'seq INTEGER NOT NULL DEFAULT 1');
    await ensureColumn(db, 'continuations', 'created_at', "created_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00'");

    await ensureColumn(db, 'messages', 'from_admin_id', 'from_admin_id TEXT');
    await ensureColumn(db, 'messages', 'is_read', 'is_read INTEGER NOT NULL DEFAULT 0');
    await ensureColumn(db, 'messages', 'created_at', "created_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00'");
    await ensureColumn(db, 'messages', 'read_at', 'read_at TEXT');

    await ensureColumn(db, 'audit_logs', 'admin_id', 'admin_id TEXT');
    await ensureColumn(db, 'audit_logs', 'target_id', 'target_id TEXT');
    await ensureColumn(db, 'audit_logs', 'details', 'details TEXT');
    await ensureColumn(db, 'audit_logs', 'created_at', "created_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00'");
  })();
  await wfSchemaReady;
}

async function ensureColumn(db, tableName, columnName, columnDef) {
  const cols = await db.prepare(`PRAGMA table_info(${tableName})`).all();
  const list = Array.isArray(cols?.results) ? cols.results : [];
  const exists = list.some((c) => c.name === columnName);
  if (exists) return;
  await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDef};`);
}

async function handleTranslate(request, env) {
  try {
    const body = await request.json().catch(() => null);
    const sourceText = body?.sourceText;
    const targetLanguage = body?.targetLanguage;
    const model = normalizeModel(body?.model);

    if (!sourceText || typeof sourceText !== 'string') {
      return json(request, env, { error: 'sourceText is required' }, 400);
    }
    if (!targetLanguage || typeof targetLanguage !== 'string') {
      return json(request, env, { error: 'targetLanguage is required' }, 400);
    }

    if (!env.DEEPSEEK_API_KEY) {
      return json(request, env, { error: 'Missing DEEPSEEK_API_KEY in Worker secrets' }, 500);
    }

    const systemPrompt = [
      '你是专业翻译助手。',
      `请先识别用户文本的原始语言，再翻译为：${targetLanguage}。`,
      '请严格只输出 JSON，不要输出任何多余文本。',
      'JSON 格式必须是：',
      '{"source_language":"<检测到的语言>","translated_text":"<翻译结果>"}',
      '要求：',
      '1) 保留原意，不要编造。',
      '2) 保持段落结构。',
      '3) 如果存在明显乱码，尽量基于上下文修复后翻译。'
    ].join('\n');

    const upstream = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: sourceText }
        ],
        temperature: 0.2
      })
    });

    const raw = await upstream.text();
    if (!upstream.ok) {
      return json(request, env, { error: `DeepSeek request failed: ${upstream.status}`, detail: raw }, upstream.status);
    }

    const data = JSON.parse(raw);
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return json(request, env, { error: 'No translated content returned by DeepSeek' }, 502);
    }

    const parsed = parseTranslationPayload(content);
    return json(request, env, {
      translatedText: parsed.translatedText,
      sourceLanguage: parsed.sourceLanguage,
      model
    }, 200);
  } catch (error) {
    return json(request, env, {
      error: 'Internal server error',
      detail: error && error.message ? error.message : String(error)
    }, 500);
  }
}

async function handleNeteaseProfile(request, env) {
  try {
    const cookie = env.NETEASE_COOKIE;
    if (!cookie) {
      return json(request, env, { error: 'Missing NETEASE_COOKIE in Worker secrets' }, 500);
    }

    const upstream = await fetch('https://music.163.com/api/nuser/account/get', {
      method: 'GET',
      headers: neteaseHeaders(cookie)
    });

    const data = await parseJsonSafe(await upstream.text());
    if (!upstream.ok || !data || data.code !== 200) {
      return json(request, env, {
        error: 'Failed to verify NetEase login profile',
        detail: data || { status: upstream.status }
      }, 502);
    }

    return json(request, env, {
      userId: data?.profile?.userId ?? null,
      nickname: data?.profile?.nickname ?? null
    }, 200);
  } catch (error) {
    return json(request, env, { error: 'NetEase profile request failed', detail: error?.message || String(error) }, 500);
  }
}

async function handleNeteaseRandomSong(request, env) {
  try {
    const cookie = env.NETEASE_COOKIE;
    if (!cookie) {
      return json(request, env, { error: 'Missing NETEASE_COOKIE in Worker secrets' }, 500);
    }

    const upstream = await fetch('https://music.163.com/api/v1/discovery/recommend/songs', {
      method: 'GET',
      headers: neteaseHeaders(cookie)
    });

    const data = await parseJsonSafe(await upstream.text());
    const list = Array.isArray(data?.recommend) ? data.recommend : [];
    if (!upstream.ok || data?.code !== 200 || list.length === 0) {
      return json(request, env, {
        error: 'Failed to fetch recommended songs from NetEase',
        detail: data || { status: upstream.status }
      }, 502);
    }

    const shuffled = [...list].sort(() => Math.random() - 0.5);
    const csrfToken = extractCsrfToken(cookie);
    for (const selected of shuffled.slice(0, 8)) {
      const songId = selected?.id;
      if (!songId) continue;

      const streamUrl = await fetchNeteasePlayableUrl(songId, cookie, csrfToken);
      if (!streamUrl) continue;

      const artists = Array.isArray(selected?.artists)
        ? selected.artists.map((a) => a?.name).filter(Boolean)
        : [];

      return json(request, env, {
        id: songId,
        name: selected?.name || '未知歌曲',
        artists,
        coverUrl: selected?.album?.picUrl || '',
        reason: selected?.reason || '随机推荐',
        streamUrl
      }, 200);
    }

    return json(request, env, {
      error: 'No playable song found in current recommendations',
      detail: '网易云推荐歌曲可能受版权/VIP限制，当前批次无可播链接。'
    }, 502);
  } catch (error) {
    return json(request, env, { error: 'NetEase random recommendation request failed', detail: error?.message || String(error) }, 500);
  }
}

async function fetchNeteasePlayableUrl(songId, cookie, csrfToken) {
  const endpoint = `https://music.163.com/api/song/enhance/player/url/v1?csrf_token=${encodeURIComponent(csrfToken)}`;
  const body = new URLSearchParams({
    ids: JSON.stringify([songId]),
    level: 'standard',
    encodeType: 'mp3'
  }).toString();

  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: {
      ...neteaseHeaders(cookie),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  const data = await parseJsonSafe(await upstream.text());
  const url = data?.data?.[0]?.url;
  if (typeof url === 'string' && url.startsWith('http')) {
    return url;
  }
  return '';
}

function parseTranslationPayload(content) {
  const direct = tryParseJson(content);
  if (direct) return normalizeResult(direct, content);

  const match = content.match(/\{[\s\S]*\}/);
  if (match) {
    const extracted = tryParseJson(match[0]);
    if (extracted) return normalizeResult(extracted, content);
  }

  return { sourceLanguage: '未知', translatedText: content };
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeResult(parsed, fallbackText) {
  const sourceLanguage =
    (typeof parsed.source_language === 'string' && parsed.source_language.trim()) ||
    (typeof parsed.sourceLanguage === 'string' && parsed.sourceLanguage.trim()) ||
    '未知';

  const translatedText =
    (typeof parsed.translated_text === 'string' && parsed.translated_text.trim()) ||
    (typeof parsed.translatedText === 'string' && parsed.translatedText.trim()) ||
    fallbackText;

  return { sourceLanguage, translatedText };
}

function json(request, env, payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(request, env, true),
      ...extraHeaders
    }
  });
}

function corsHeaders(request, env, withCredentials) {
  const reqOrigin = request.headers.get('Origin') || '';
  const allowListRaw = String(env?.WF_CORS_ORIGIN || '*').trim();
  let allowOrigin = '*';

  if (allowListRaw !== '*') {
    const allowList = allowListRaw.split(',').map((x) => x.trim()).filter(Boolean);
    allowOrigin = allowList.includes(reqOrigin) ? reqOrigin : (allowList[0] || reqOrigin || '*');
  } else if (withCredentials && reqOrigin) {
    allowOrigin = reqOrigin;
  }

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
    ...(withCredentials ? { 'Access-Control-Allow-Credentials': 'true' } : {})
  };
}

function neteaseHeaders(cookie) {
  return {
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://music.163.com/',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
    Cookie: cookie
  };
}

function parseJsonSafe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractCsrfToken(cookie) {
  const match = cookie.match(/(?:^|;\s*)__csrf=([^;]+)/);
  return match ? match[1] : '';
}

function normalizeModel(input) {
  const raw = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (!raw) return 'deepseek-chat';
  if (raw === 'chat' || raw === 'deepseek-chat') return 'deepseek-chat';
  if (raw === 'reasoner' || raw === 'resoner' || raw === 'deepseek-reasoner') return 'deepseek-reasoner';
  return 'deepseek-chat';
}

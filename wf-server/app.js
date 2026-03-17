const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { createAIProvider } = require('./ai-provider');

const SESSION_DAYS = 14;
const MESSAGE_RETENTION_DAYS = 3;

function nowIso() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function plusDays(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function fail(res, status, error) {
  return res.status(status).json({ error });
}

function cleanMessageData(db) {
  const threshold = new Date(Date.now() - MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  db.prepare('DELETE FROM messages WHERE is_read = 1 AND read_at IS NOT NULL AND read_at < ?').run(threshold);
}

function visibleName(row) {
  if (!row) return '已删除用户';
  return row.username || '已删除用户';
}

function createApp({ db, aiProvider, corsOrigin } = {}) {
  if (!db) throw new Error('db is required');
  const app = express();
  const provider = aiProvider || createAIProvider(process.env);

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use((req, res, next) => {
    if (corsOrigin) {
      res.header('Access-Control-Allow-Origin', corsOrigin);
      res.header('Access-Control-Allow-Credentials', 'true');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  async function attachUser(req, _res, next) {
    const sessionId = req.cookies.wf_sid;
    req.user = null;
    if (!sessionId) return next();

    const session = db
      .prepare(
        `SELECT s.id, s.user_id, s.expires_at, u.username, u.role
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.id = ?`
      )
      .get(sessionId);

    if (!session) return next();
    if (session.expires_at < nowIso()) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
      return next();
    }

    req.user = {
      id: session.user_id,
      username: session.username,
      role: session.role,
    };
    return next();
  }

  function requireAuth(req, res, next) {
    if (!req.user) return fail(res, 401, '请先登录');
    return next();
  }

  function requireAdmin(req, res, next) {
    if (!req.user) return fail(res, 401, '请先登录');
    if (req.user.role !== 'admin') return fail(res, 403, '仅管理员可操作');
    return next();
  }

  function writeAudit(adminId, action, targetType, targetId, details) {
    db.prepare(
      'INSERT INTO audit_logs (id, admin_id, action, target_type, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(uuidv4(), adminId, action, targetType, targetId || null, details ? JSON.stringify(details) : null, nowIso());
  }

  function notifyUserByProject(projectId, adminId, content) {
    const row = db.prepare('SELECT creator_id FROM projects WHERE id = ?').get(projectId);
    if (!row || !row.creator_id) return;
    db.prepare(
      'INSERT INTO messages (id, user_id, from_admin_id, content, is_read, created_at, read_at) VALUES (?, ?, ?, ?, 0, ?, NULL)'
    ).run(uuidv4(), row.creator_id, adminId, content, nowIso());
  }

  const claimProjectTx = db.transaction((projectId, userId) => {
    const project = db.prepare('SELECT id, status, current_writer_id FROM projects WHERE id = ?').get(projectId);
    if (!project) return { ok: false, code: 404, error: '项目不存在' };
    if (project.status === 'completed') return { ok: false, code: 409, error: '项目已完成，不可续写' };
    if (project.current_writer_id && project.current_writer_id !== userId) {
      return { ok: false, code: 409, error: '当前已有其他用户持有续写权' };
    }

    db.prepare(
      `UPDATE projects
       SET current_writer_id = ?, lock_version = lock_version + 1, updated_at = ?
       WHERE id = ? AND (current_writer_id IS NULL OR current_writer_id = ?)`
    ).run(userId, nowIso(), projectId, userId);

    return { ok: true };
  });

  const continueProjectTx = db.transaction((projectId, userId, content) => {
    const project = db.prepare('SELECT id, status, current_writer_id FROM projects WHERE id = ?').get(projectId);
    if (!project) return { ok: false, code: 404, error: '项目不存在' };
    if (project.status === 'completed') return { ok: false, code: 409, error: '项目已完成，不可续写' };
    if (project.current_writer_id !== userId) return { ok: false, code: 409, error: '你未持有续写权' };

    const safe = String(content || '').trim();
    if (safe) {
      const nextSeqRow = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM continuations WHERE project_id = ?').get(projectId);
      db.prepare(
        'INSERT INTO continuations (id, project_id, author_id, content, seq, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(uuidv4(), projectId, userId, safe, nextSeqRow.nextSeq, nowIso());
    }

    db.prepare('UPDATE projects SET current_writer_id = NULL, lock_version = lock_version + 1, updated_at = ? WHERE id = ?').run(nowIso(), projectId);
    return { ok: true, added: Boolean(safe) };
  });

  app.use('/wf/api', attachUser);

  app.get('/wf/api/health', (_req, res) => {
    res.json({ ok: true, service: 'wf-server', aiProvider: provider.name });
  });

  app.post('/wf/api/auth/register', (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || username.length < 2) return fail(res, 400, '用户名至少 2 个字符');
    if (password.length < 6) return fail(res, 400, '密码至少 6 位');

    const existed = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existed) return fail(res, 409, '用户名已存在');

    const hash = bcrypt.hashSync(password, 12);
    const role = username === String(process.env.WF_ADMIN_USERNAME || 'admin') ? 'admin' : 'user';
    db.prepare('INSERT INTO users (id, username, password_hash, role, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, NULL)').run(
      uuidv4(),
      username,
      hash,
      role,
      nowIso()
    );

    return res.json({ ok: true, role });
  });

  app.post('/wf/api/auth/login', (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const user = db.prepare('SELECT id, username, password_hash, role FROM users WHERE username = ?').get(username);

    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return fail(res, 401, '用户名或密码错误');
    }

    const sid = uuidv4();
    db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
      sid,
      user.id,
      nowIso(),
      plusDays(SESSION_DAYS)
    );

    res.cookie('wf_sid', sid, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    });

    return res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
  });

  app.post('/wf/api/auth/logout', requireAuth, (req, res) => {
    const sid = req.cookies.wf_sid;
    if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    res.clearCookie('wf_sid');
    res.json({ ok: true });
  });

  app.get('/wf/api/auth/me', (req, res) => {
    if (!req.user) return res.json({ loggedIn: false });
    cleanMessageData(db);
    const unread = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND is_read = 0').get(req.user.id).c;
    return res.json({ loggedIn: true, user: req.user, unreadCount: unread });
  });

  app.post('/wf/api/projects', requireAuth, async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const openingMode = String(req.body?.openingMode || '').trim();
    const openingText = String(req.body?.openingText || '').trim();

    if (!name) return fail(res, 400, '项目名不能为空');
    if (!['ai', 'manual'].includes(openingMode)) return fail(res, 400, 'openingMode 必须是 ai 或 manual');

    let firstParagraph = openingText;
    if (openingMode === 'ai') {
      firstParagraph = await provider.generateOpening(name);
    }
    if (!String(firstParagraph || '').trim()) return fail(res, 400, '开头内容不能为空');

    const projectId = uuidv4();
    const t = nowIso();

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO projects (id, name, status, creator_id, current_writer_id, lock_version, created_at, updated_at)
         VALUES (?, ?, 'in_progress', ?, NULL, 0, ?, ?)`
      ).run(projectId, name, req.user.id, t, t);

      db.prepare(
        'INSERT INTO continuations (id, project_id, author_id, content, seq, created_at) VALUES (?, ?, ?, ?, 1, ?)'
      ).run(uuidv4(), projectId, req.user.id, String(firstParagraph).trim(), t);
    });

    tx();
    res.json({ ok: true, projectId, opening: String(firstParagraph).trim() });
  });

  app.post('/wf/api/ai/opening', requireAuth, async (req, res) => {
    const name = String(req.body?.name || '').trim() || '流浪小说';
    const opening = await provider.generateOpening(name);
    return res.json({ opening, provider: provider.name });
  });

  app.get('/wf/api/projects', requireAuth, (req, res) => {
    const projects = db
      .prepare(
        `SELECT p.id, p.name, p.status, p.creator_id, p.current_writer_id, p.created_at, p.updated_at,
                cu.username AS creator_name, wu.username AS writer_name
         FROM projects p
         LEFT JOIN users cu ON cu.id = p.creator_id
         LEFT JOIN users wu ON wu.id = p.current_writer_id
         ORDER BY p.updated_at DESC`
      )
      .all();

    const continuationStmt = db.prepare(
      `SELECT c.id, c.project_id, c.author_id, c.content, c.seq, c.created_at, u.username AS author_name
       FROM continuations c
       LEFT JOIN users u ON u.id = c.author_id
       WHERE c.project_id = ?
       ORDER BY c.seq ASC`
    );

    const formatted = projects.map((p) => {
      const lines = continuationStmt.all(p.id).map((line) => ({
        id: line.id,
        authorId: line.author_id,
        authorName: visibleName(line),
        content: line.content,
        seq: line.seq,
        createdAt: line.created_at,
      }));
      return {
        id: p.id,
        name: p.name,
        status: p.status,
        creatorId: p.creator_id,
        creatorName: p.creator_name || '已删除用户',
        currentWriterId: p.current_writer_id,
        currentWriterName: p.writer_name || null,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        continuations: lines,
      };
    });

    res.json({ projects: formatted });
  });

  app.post('/wf/api/projects/:id/claim', requireAuth, (req, res) => {
    const result = claimProjectTx(req.params.id, req.user.id);
    if (!result.ok) return fail(res, result.code, result.error);
    return res.json({ ok: true });
  });

  app.post('/wf/api/projects/:id/continue', requireAuth, (req, res) => {
    const result = continueProjectTx(req.params.id, req.user.id, req.body?.content || '');
    if (!result.ok) return fail(res, result.code, result.error);
    return res.json({ ok: true, addedContent: result.added });
  });

  app.post('/wf/api/projects/:id/complete', requireAuth, (req, res) => {
    const project = db.prepare('SELECT id, creator_id, status FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return fail(res, 404, '项目不存在');
    const can = req.user.role === 'admin' || project.creator_id === req.user.id;
    if (!can) return fail(res, 403, '仅创建者或管理员可完成项目');

    db.prepare('UPDATE projects SET status = ?, current_writer_id = NULL, updated_at = ? WHERE id = ?').run(
      'completed',
      nowIso(),
      project.id
    );

    if (req.user.role === 'admin' && project.creator_id) {
      writeAudit(req.user.id, 'force_complete_project', 'project', project.id, {});
      notifyUserByProject(project.id, req.user.id, '管理员已强制完成你的流浪小说项目。');
    }

    res.json({ ok: true });
  });

  app.post('/wf/api/projects/:id/reopen', requireAdmin, (req, res) => {
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return fail(res, 404, '项目不存在');

    db.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').run('in_progress', nowIso(), project.id);
    writeAudit(req.user.id, 'reopen_project', 'project', project.id, {});
    notifyUserByProject(project.id, req.user.id, '管理员已将你的项目重新开放续写。');
    res.json({ ok: true });
  });

  app.delete('/wf/api/projects/:id', requireAuth, (req, res) => {
    const project = db.prepare('SELECT id, creator_id FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return fail(res, 404, '项目不存在');

    if (req.user.role !== 'admin' && project.creator_id !== req.user.id) {
      return fail(res, 403, '普通用户只能删除自己创建的项目');
    }

    const creatorId = project.creator_id;
    db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
    if (req.user.role === 'admin') {
      writeAudit(req.user.id, 'force_delete_project', 'project', project.id, {});
      if (creatorId) {
        db.prepare(
          'INSERT INTO messages (id, user_id, from_admin_id, content, is_read, created_at, read_at) VALUES (?, ?, ?, ?, 0, ?, NULL)'
        ).run(uuidv4(), creatorId, req.user.id, '管理员已删除你的流浪小说项目。', nowIso());
      }
    }
    return res.json({ ok: true });
  });

  app.delete('/wf/api/continuations/:id', requireAuth, (req, res) => {
    const line = db.prepare('SELECT id, project_id, author_id, seq FROM continuations WHERE id = ?').get(req.params.id);
    if (!line) return fail(res, 404, '续写不存在');

    if (req.user.role === 'admin') {
      db.prepare('DELETE FROM continuations WHERE id = ?').run(line.id);
      writeAudit(req.user.id, 'delete_any_continuation', 'continuation', line.id, { projectId: line.project_id });
      return res.json({ ok: true });
    }

    if (line.author_id !== req.user.id) return fail(res, 403, '只能删除自己的续写');

    const latest = db.prepare('SELECT id FROM continuations WHERE project_id = ? ORDER BY seq DESC LIMIT 1').get(line.project_id);
    if (!latest || latest.id !== line.id) {
      return fail(res, 409, '该续写已被后续覆盖，不能删除');
    }

    db.prepare('DELETE FROM continuations WHERE id = ?').run(line.id);
    return res.json({ ok: true });
  });

  app.get('/wf/api/messages/unread-count', requireAuth, (req, res) => {
    cleanMessageData(db);
    const row = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND is_read = 0').get(req.user.id);
    res.json({ unreadCount: row.c });
  });

  app.get('/wf/api/messages', requireAuth, (req, res) => {
    cleanMessageData(db);
    const rows = db
      .prepare(
        `SELECT m.id, m.content, m.is_read, m.created_at, m.read_at, u.username AS from_admin_name
         FROM messages m
         LEFT JOIN users u ON u.id = m.from_admin_id
         WHERE m.user_id = ?
         ORDER BY m.created_at DESC`
      )
      .all(req.user.id);
    res.json({
      messages: rows.map((x) => ({
        id: x.id,
        content: x.content,
        isRead: x.is_read === 1,
        createdAt: x.created_at,
        readAt: x.read_at,
        fromAdminName: x.from_admin_name || '系统管理员',
      })),
    });
  });

  app.post('/wf/api/messages/mark-all-read', requireAuth, (req, res) => {
    db.prepare('UPDATE messages SET is_read = 1, read_at = ? WHERE user_id = ? AND is_read = 0').run(nowIso(), req.user.id);
    res.json({ ok: true });
  });

  app.get('/wf/api/admin/users', requireAdmin, (_req, res) => {
    const users = db
      .prepare(
        `SELECT u.id, u.username, u.role, u.created_at,
                (SELECT COUNT(*) FROM projects p WHERE p.creator_id = u.id) AS project_count
         FROM users u
         ORDER BY u.created_at DESC`
      )
      .all();
    res.json({ users });
  });

  app.post('/wf/api/admin/messages', requireAdmin, (req, res) => {
    const toUserId = String(req.body?.toUserId || '');
    const content = String(req.body?.content || '').trim();
    if (!toUserId) return fail(res, 400, 'toUserId 不能为空');
    if (!content) return fail(res, 400, '消息内容不能为空');

    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(toUserId);
    if (!user) return fail(res, 404, '用户不存在');

    db.prepare(
      'INSERT INTO messages (id, user_id, from_admin_id, content, is_read, created_at, read_at) VALUES (?, ?, ?, ?, 0, ?, NULL)'
    ).run(uuidv4(), toUserId, req.user.id, content, nowIso());

    writeAudit(req.user.id, 'send_message', 'user', toUserId, { content });
    res.json({ ok: true });
  });

  app.delete('/wf/api/admin/users/:id', requireAdmin, (req, res) => {
    const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.params.id);
    if (!user) return fail(res, 404, '用户不存在');
    if (user.role === 'admin') return fail(res, 400, '不能删除管理员账号');

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
      writeAudit(req.user.id, 'delete_user', 'user', user.id, {});
    });
    tx();
    res.json({ ok: true });
  });

  app.get('/wf/api/admin/projects', requireAdmin, (_req, res) => {
    const rows = db
      .prepare(
        `SELECT p.id, p.name, p.status, p.created_at, p.updated_at, u.username AS creator_name
         FROM projects p
         LEFT JOIN users u ON u.id = p.creator_id
         ORDER BY p.updated_at DESC`
      )
      .all();
    res.json({ projects: rows });
  });

  app.delete('/wf/api/admin/projects/:id', requireAdmin, (req, res) => {
    const project = db.prepare('SELECT id, creator_id FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return fail(res, 404, '项目不存在');

    const creatorId = project.creator_id;
    db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
    writeAudit(req.user.id, 'force_delete_project', 'project', project.id, {});
    if (creatorId) {
      db.prepare(
        'INSERT INTO messages (id, user_id, from_admin_id, content, is_read, created_at, read_at) VALUES (?, ?, ?, ?, 0, ?, NULL)'
      ).run(uuidv4(), creatorId, req.user.id, '管理员已强制删除你的项目。', nowIso());
    }
    res.json({ ok: true });
  });

  app.post('/wf/api/admin/projects/:id/complete', requireAdmin, (req, res) => {
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return fail(res, 404, '项目不存在');

    db.prepare('UPDATE projects SET status = ?, current_writer_id = NULL, updated_at = ? WHERE id = ?').run('completed', nowIso(), project.id);
    writeAudit(req.user.id, 'force_complete_project', 'project', project.id, {});
    notifyUserByProject(project.id, req.user.id, '管理员已强制完成你的项目。');
    res.json({ ok: true });
  });

  app.post('/wf/api/admin/projects/:id/reopen', requireAdmin, (req, res) => {
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return fail(res, 404, '项目不存在');

    db.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').run('in_progress', nowIso(), project.id);
    writeAudit(req.user.id, 'reopen_project', 'project', project.id, {});
    notifyUserByProject(project.id, req.user.id, '管理员已重新开放你的项目。');
    res.json({ ok: true });
  });

  app.get('/wf/api/projects/:id/export.txt', requireAdmin, (req, res) => {
    const project = db
      .prepare(
        `SELECT p.id, p.name, p.status, p.created_at, u.username AS creator_name
         FROM projects p
         LEFT JOIN users u ON u.id = p.creator_id
         WHERE p.id = ?`
      )
      .get(req.params.id);
    if (!project) return fail(res, 404, '项目不存在');

    const lines = db
      .prepare(
        `SELECT c.content, c.created_at, u.username AS author_name
         FROM continuations c
         LEFT JOIN users u ON u.id = c.author_id
         WHERE c.project_id = ?
         ORDER BY c.seq ASC`
      )
      .all(project.id);

    const chunks = [];
    chunks.push('项目名: ' + project.name);
    chunks.push('状态: ' + project.status);
    chunks.push('创建者: ' + (project.creator_name || '已删除用户'));
    chunks.push('创建时间: ' + project.created_at);
    chunks.push('');
    chunks.push('续写内容:');
    lines.forEach((line, index) => {
      chunks.push('[' + (index + 1) + '] 作者: ' + (line.author_name || '已删除用户'));
      chunks.push('时间: ' + line.created_at);
      chunks.push('内容: ' + line.content);
      chunks.push('');
    });

    const filename = encodeURIComponent(project.name + '.txt');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + filename);
    res.send(chunks.join('\n'));
  });

  app.get('/wf/api/admin/audit-logs', requireAdmin, (_req, res) => {
    const logs = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200').all();
    res.json({ logs });
  });

  return app;
}

module.exports = { createApp };

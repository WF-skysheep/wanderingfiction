const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const request = require('supertest');

const { runMigrations } = require('../db');
const { createApp } = require('../app');

function makeApp() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const app = createApp({
    db,
    aiProvider: {
      name: 'mock',
      async generateOpening(projectName) {
        return projectName + ' 的开头。';
      },
    },
  });
  return { app, db };
}

async function registerAndLogin(agent, username, password = '123456') {
  await agent.post('/wf/api/auth/register').send({ username, password }).expect(200);
  await agent.post('/wf/api/auth/login').send({ username, password }).expect(200);
}

test('鉴权：未登录不可读项目', async () => {
  const { app } = makeApp();
  await request(app).get('/wf/api/projects').expect(401);
});

test('续写锁：同一时间只允许一个人持有', async () => {
  const { app } = makeApp();
  const u1 = request.agent(app);
  const u2 = request.agent(app);

  await registerAndLogin(u1, 'u1');
  await registerAndLogin(u2, 'u2');

  const createRes = await u1.post('/wf/api/projects').send({
    name: '测试项目',
    openingMode: 'manual',
    openingText: '开头',
  }).expect(200);
  const projectId = createRes.body.projectId;

  await u1.post('/wf/api/projects/' + projectId + '/claim').expect(200);
  await u2.post('/wf/api/projects/' + projectId + '/claim').expect(409);
});

test('消息：管理员多次发送同一用户应全部保留', async () => {
  const { app } = makeApp();
  const admin = request.agent(app);
  const user = request.agent(app);

  await registerAndLogin(admin, 'admin');
  await registerAndLogin(user, 'normal');

  const users = await admin.get('/wf/api/admin/users').expect(200);
  const target = users.body.users.find((x) => x.username === 'normal');
  assert.ok(target);

  await admin.post('/wf/api/admin/messages').send({ toUserId: target.id, content: '第一条' }).expect(200);
  await admin.post('/wf/api/admin/messages').send({ toUserId: target.id, content: '第二条' }).expect(200);

  const inbox = await user.get('/wf/api/messages').expect(200);
  assert.equal(inbox.body.messages.length, 2);
});

test('删除规则：普通用户只能删除自己最新且未覆盖的续写', async () => {
  const { app } = makeApp();
  const u1 = request.agent(app);
  const u2 = request.agent(app);

  await registerAndLogin(u1, 'writer1');
  await registerAndLogin(u2, 'writer2');

  const createRes = await u1.post('/wf/api/projects').send({
    name: '规则项目',
    openingMode: 'manual',
    openingText: '首段',
  }).expect(200);
  const projectId = createRes.body.projectId;

  await u1.post('/wf/api/projects/' + projectId + '/claim').expect(200);
  await u1.post('/wf/api/projects/' + projectId + '/continue').send({ content: 'writer1 第二段' }).expect(200);

  await u2.post('/wf/api/projects/' + projectId + '/claim').expect(200);
  await u2.post('/wf/api/projects/' + projectId + '/continue').send({ content: 'writer2 第三段' }).expect(200);

  const p = await u1.get('/wf/api/projects').expect(200);
  const lines = p.body.projects[0].continuations;
  const u1Second = lines.find((x) => x.content === 'writer1 第二段');
  assert.ok(u1Second);

  await u1.delete('/wf/api/continuations/' + u1Second.id).expect(409);
});

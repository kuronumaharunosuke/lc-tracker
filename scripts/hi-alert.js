const admin = require('firebase-admin');

const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
);

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function main() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const in3days = new Date(today);
  in3days.setDate(in3days.getDate() + 3);

  const fmt = (d) => `${d.getMonth()+1}/${d.getDate()}`;
  const toDate = (s) => { const d = new Date(s); d.setHours(0,0,0,0); return d; };

  const todayDay = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() - (todayDay === 0 ? 6 : todayDay - 1));
  const thisWeekKey = `${monday.getFullYear()}-${String(monday.getMonth()+1).padStart(2,'0')}-${String(monday.getDate()).padStart(2,'0')}`;

  const snap = await db.collection('lc-tracker-2627').doc('main').get();
  if (!snap.exists) { console.log('データなし'); return; }

  const payload = JSON.parse(snap.data().payload || '{}');
  const hi = (payload.lcs || []).find(lc => lc.id === 'HI');
  if (!hi) { console.log('HIデータなし'); return; }

  const taskAlerts = [];
  // byArea[areaId] = { linkedByTask: {taskName: {res, todos:[]}}, manual: [] }
  const todoByArea = {};

  Object.entries(hi.areas || {}).forEach(([areaId, area]) => {
    (area.kpis || []).forEach(kpi => {
      (kpi.tasks || []).forEach(task => {
        if (task.deadline && task.status !== 'DONE') {
          const deadline = toDate(task.deadline);
          if (deadline >= today && deadline <= in3days) {
            const daysLeft = Math.round((deadline - today) / 86400000);
            taskAlerts.push({ areaId, kpiName: kpi.name, taskName: task.name, res: task.res, deadline: task.deadline, daysLeft, status: task.status });
          }
        }
        const pendingTodos = (task.todos || []).filter(td => td.week === thisWeekKey && !td.done);
        if (pendingTodos.length > 0) {
          if (!todoByArea[areaId]) todoByArea[areaId] = { linkedByTask: {}, manual: [] };
          todoByArea[areaId].linkedByTask[task.name] = {
            res: task.res || '',
            todos: pendingTodos.map(td => td.name)
          };
        }
      });
    });
    (area.weekTodos || []).forEach(todo => {
      if (todo.week === thisWeekKey && !todo.done) {
        if (!todoByArea[areaId]) todoByArea[areaId] = { linkedByTask: {}, manual: [] };
        todoByArea[areaId].manual.push({ name: todo.name, res: todo.res || '' });
      }
    });
  });

  const todoTotal = Object.values(todoByArea).reduce((sum, a) => {
    const linked = Object.values(a.linkedByTask).reduce((s, t) => s + t.todos.length, 0);
    return sum + linked + a.manual.length;
  }, 0);

  if (taskAlerts.length === 0 && todoTotal === 0) {
    console.log('アラート対象なし'); return;
  }

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `⚠️ HI アラート ${fmt(today)}`, emoji: true } }
  ];

  if (taskAlerts.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*📌 締め切り3日以内のタスク（${taskAlerts.length}件）*` } });
    const byArea = {};
    taskAlerts.forEach(a => { if (!byArea[a.areaId]) byArea[a.areaId] = []; byArea[a.areaId].push(a); });
    Object.entries(byArea).forEach(([areaId, tasks]) => {
      const lines = tasks.map(t => {
        const urgency = t.daysLeft === 0 ? '🔴' : t.daysLeft === 1 ? '🟠' : '🟡';
        const dayLabel = t.daysLeft === 0 ? '今日' : t.daysLeft === 1 ? '明日' : `${t.daysLeft}日後`;
        const status = t.status === 'WIP' ? 'WIP' : '未着手';
        return `${urgency} *${t.taskName}* — ${dayLabel} (${t.deadline})  \`${status}\`${t.res ? `  担当: ${t.res}` : ''}`;
      }).join('\n');
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${areaId}*\n${lines}` } });
    });
  }

  if (todoTotal > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*📋 今週の週次ToDo（未完了 ${todoTotal}件）*` } });

    Object.entries(todoByArea).forEach(([areaId, data]) => {
      const linkedCount = Object.values(data.linkedByTask).reduce((s, t) => s + t.todos.length, 0);
      const totalCount = linkedCount + data.manual.length;

      const chunks = [];
      chunks.push(`*${areaId}* (${totalCount}件)`);

      Object.entries(data.linkedByTask).forEach(([taskName, info]) => {
        const resLabel = info.res ? ` — ${info.res}` : '';
        chunks.push(`\n📂 _${taskName}_${resLabel}`);
        info.todos.forEach(td => {
          chunks.push(`   • ${td}`);
        });
      });

      if (data.manual.length > 0) {
        chunks.push(`\n✏️ _手動追加_`);
        data.manual.forEach(m => {
          chunks.push(`   • ${m.name}${m.res ? `  担当: ${m.res}` : ''}`);
        });
      }

      // Slack block has 3000 char limit per section — split if needed
      const fullText = chunks.join('\n');
      if (fullText.length <= 2900) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: fullText } });
      } else {
        // split into chunks of ~2900 chars at newline boundaries
        let buf = chunks[0] + '\n';
        for (let i = 1; i < chunks.length; i++) {
          if ((buf + chunks[i]).length > 2900) {
            blocks.push({ type: 'section', text: { type: 'mrkdwn', text: buf } });
            buf = '';
          }
          buf += chunks[i] + '\n';
        }
        if (buf.trim()) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: buf } });
      }
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '🔗 <https://kuronumaharunosuke.github.io/lc-tracker/#lc-HI|Action Tracker - HI>' }] });

  const res = await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks })
  });

  if (res.ok) { console.log(`✅ 送信完了 (タスク${taskAlerts.length}件 / ToDo${todoTotal}件)`); }
  else { console.error('❌ 送信失敗:', await res.text()); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });

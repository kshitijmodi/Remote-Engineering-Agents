const { PlanningAgent }     = require('./src/agents/PlanningAgent');
const { ExecutionAgent }    = require('./src/agents/ExecutionAgent');
const { DebuggingAgent }    = require('./src/agents/DebuggingAgent');
const { ReviewAgent }       = require('./src/agents/ReviewAgent');
const { LoggingAgent }      = require('./src/agents/LoggingAgent');
const { OrchestratorAgent, STATES } = require('./src/agents/OrchestratorAgent');
const { BudgetExceededError, buildMultimodalBlocks } = require('./src/claude/ClaudeCodeExecutor');
const { inferMimeType, isImage, isPdf, extractMediaMetadata, buildImageBlock, buildPdfBlock, buildContentBlocksFromAttachments } = require('./src/utils/MultimodalHandler');
const { extractUrls, isValidUrl, categoriseContentType } = require('./src/utils/LinkProcessor');
const { parseConfirmationCommand, buildMessage } = require('./src/messaging/MessagingLayer');
const { ContextAgent } = require('./src/agents/ContextAgent');
const { IntentAgent }       = require('./src/agents/IntentAgent');
const os   = require('os');
const path = require('path');
const fs   = require('fs');

const mockBudget = { current: 2, max: 15 };
const fakeExec = {
  budgetStatus: mockBudget,
  extendBudget: () => {},
  run: async () => ({ success: true, output: '', budget: mockBudget, exitCode: 0 }),
};

async function main() {
  console.log('All modules load OK\n');

  // ── PlanningAgent ────────────────────────────────────────────────────────
  const planner = new PlanningAgent(fakeExec);
  const steps = planner._parseSteps('1. Create utils/export.js\n2. Add exportToCsv function\n3. Write tests');
  console.assert(steps.length === 3, 'PlanningAgent: 3 steps');
  console.assert(steps[0] === 'Create utils/export.js', 'PlanningAgent: step text');
  console.log('PASS: PlanningAgent step parsing');

  // ── ReviewAgent ──────────────────────────────────────────────────────────
  const reviewer = new ReviewAgent(fakeExec);
  console.assert(reviewer._parseVerdict('PASS - looks good').verdict === 'PASS', 'ReviewAgent: PASS');
  console.assert(reviewer._parseVerdict('FAIL: Missing null check').verdict === 'FAIL', 'ReviewAgent: FAIL');
  console.assert(reviewer._parseVerdict('PASS but also FAIL').verdict === 'FAIL', 'ReviewAgent: FAIL takes priority');
  console.log('PASS: ReviewAgent verdict parsing');

  // ── LoggingAgent ─────────────────────────────────────────────────────────
  const logger = new LoggingAgent();
  logger.startTask('test-001');
  logger.log('test-001', 'INFO', 'Hello from test');
  logger.log('test-001', 'STATE', 'queued → planning');
  logger.checkpoint('test-001', { status: 'planning', retries: {} });
  const cp = logger.loadCheckpoint('test-001');
  console.assert(cp?.status === 'planning', 'LoggingAgent: checkpoint round-trips');
  logger.endTask('test-001');
  const tail = logger.getTailLogs('test-001', 10);
  console.assert(tail.includes('INFO'), 'LoggingAgent: tail contains entries');
  console.log('PASS: LoggingAgent write/checkpoint/read');

  // ── OrchestratorAgent: happy path ────────────────────────────────────────
  const messages = [];
  const agents = {
    executor:  fakeExec,
    planning:  new PlanningAgent(fakeExec),
    execution: new ExecutionAgent(fakeExec),
    debugging: new DebuggingAgent(fakeExec),
    review:    new ReviewAgent(fakeExec),
    logging:   new LoggingAgent(),
  };
  agents.planning.plan      = async () => ({ success: true, steps: ['Step 1', 'Step 2'], rawOutput: '', budget: mockBudget });
  agents.execution.code     = async () => ({ success: true, output: 'Done', budget: mockBudget, exitCode: 0 });
  agents.execution.test     = async () => ({ passed: true, passedCount: 4, failedCount: 0, details: 'All passed', rawOutput: '', budget: mockBudget, executorSuccess: true });
  agents.review.review      = async () => ({ passed: true, verdict: 'PASS', reasons: 'Looks good', diff: '', budget: mockBudget });

  const orch = new OrchestratorAgent(agents, async (uid, msg) => messages.push(msg));
  orch.startTask('user@c.us', 'Add CSV export', '/fake/path');
  await new Promise(r => setTimeout(r, 500));

  console.assert(messages.some(m => m.includes('Planning')),    'Orchestrator: planning msg');
  console.assert(messages.some(m => m.includes('Coding')),      'Orchestrator: coding msg');
  console.assert(messages.some(m => m.includes('Tests passed')),'Orchestrator: tests passed');
  console.assert(messages.some(m => m.includes('PASS')),        'Orchestrator: review pass');
  console.log('PASS: OrchestratorAgent happy path');

  // ── OrchestratorAgent: debug retry loop ─────────────────────────────────
  let debugCalls = 0;
  const failMessages = [];
  const agents2 = { ...agents, logging: new LoggingAgent() };
  agents2.execution = new ExecutionAgent(fakeExec);
  agents2.execution.code = async () => ({ success: true, output: 'Done', budget: mockBudget, exitCode: 0 });
  // Fail tests twice, pass on 3rd
  let testAttempts = 0;
  agents2.execution.test = async () => {
    testAttempts++;
    if (testAttempts <= 2) return { passed: false, passedCount: 0, failedCount: 1, details: 'TypeError', rawOutput: 'fail', budget: mockBudget, executorSuccess: true };
    return { passed: true, passedCount: 3, failedCount: 0, details: '', rawOutput: '', budget: mockBudget, executorSuccess: true };
  };
  agents2.debugging = new DebuggingAgent(fakeExec);
  agents2.debugging.fix = async (...args) => { debugCalls++; return { success: true, output: 'Fixed', attempt: args[3], budget: mockBudget, exitCode: 0 }; };
  agents2.review = new ReviewAgent(fakeExec);
  agents2.review.review = async () => ({ passed: true, verdict: 'PASS', reasons: '', diff: '', budget: mockBudget });

  const orch2 = new OrchestratorAgent(agents2, async (uid, msg) => failMessages.push(msg));
  orch2.startTask('user2@c.us', 'Add feature', '/fake/path');
  await new Promise(r => setTimeout(r, 600));

  console.assert(debugCalls === 2, `Orchestrator: debugger called ${debugCalls} times (expected 2)`);
  console.assert(failMessages.some(m => m.includes('debug attempt')), 'Orchestrator: debug attempt msg sent');
  console.assert(failMessages.some(m => m.includes('PASS')), 'Orchestrator: eventually passed');
  console.log('PASS: OrchestratorAgent debug retry loop');

  // ── OrchestratorAgent: budget exceeded → PAUSED ──────────────────────────
  const budgetExec = {
    budgetStatus: { current: 15, max: 15 },
    extendBudget: () => {},
    run: async () => { throw new BudgetExceededError({ current: 15, max: 15 }); },
  };
  const pausedMsgs = [];
  const agents3 = { ...agents, executor: budgetExec, logging: new LoggingAgent() };
  agents3.planning = new PlanningAgent(budgetExec);
  agents3.planning.plan = async () => { throw new BudgetExceededError({ current: 15, max: 15 }); };
  const orch3 = new OrchestratorAgent(agents3, async (uid, msg) => pausedMsgs.push(msg));
  orch3.startTask('user3@c.us', 'Some task', '/fake/path');
  await new Promise(r => setTimeout(r, 300));
  const t3 = orch3.getActiveTask('user3@c.us');
  console.assert(t3?.status === STATES.PAUSED, `Orchestrator: status is ${t3?.status}, expected paused`);
  console.assert(pausedMsgs.some(m => m.includes('execution limit')), 'Orchestrator: budget msg sent');
  console.log('PASS: OrchestratorAgent budget exhaustion → PAUSED');

  // ── OrchestratorAgent: cancel ────────────────────────────────────────────
  const agents4 = { ...agents, logging: new LoggingAgent() };
  agents4.planning = new PlanningAgent(fakeExec);
  // Planning hangs — simulates long-running task
  agents4.planning.plan = () => new Promise(() => {});
  const orch4 = new OrchestratorAgent(agents4, async () => {});
  orch4.startTask('user4@c.us', 'Long task', '/fake/path');
  await new Promise(r => setTimeout(r, 50));
  orch4.cancelTask('user4@c.us');
  await new Promise(r => setTimeout(r, 100));
  const t4 = orch4.getActiveTask('user4@c.us');
  console.assert(t4?.status === STATES.CANCELLED, 'Orchestrator: cancel sets CANCELLED');
  console.log('PASS: OrchestratorAgent cancel');

  // ── MultimodalHandler: MIME inference ────────────────────────────────────
  console.assert(inferMimeType('photo.jpg')  === 'image/jpeg',       'MultimodalHandler: .jpg → image/jpeg');
  console.assert(inferMimeType('doc.pdf')    === 'application/pdf',   'MultimodalHandler: .pdf → application/pdf');
  console.assert(inferMimeType('image.PNG')  === 'image/png',         'MultimodalHandler: .PNG → image/png');
  console.assert(inferMimeType('file.txt')   === null,                'MultimodalHandler: .txt → null');
  console.log('PASS: MultimodalHandler MIME inference');

  // ── MultimodalHandler: type predicates ───────────────────────────────────
  console.assert(isImage('image/jpeg') === true,           'MultimodalHandler: isImage jpeg');
  console.assert(isImage('image/webp') === true,           'MultimodalHandler: isImage webp');
  console.assert(isImage('application/pdf') === false,     'MultimodalHandler: isImage rejects pdf');
  console.assert(isPdf('application/pdf') === true,        'MultimodalHandler: isPdf true');
  console.assert(isPdf('image/jpeg') === false,            'MultimodalHandler: isPdf rejects jpeg');
  console.log('PASS: MultimodalHandler type predicates');

  // ── MultimodalHandler: extractMediaMetadata ───────────────────────────────
  const imgMeta = extractMediaMetadata({ mimetype: 'image/png', filename: 'screenshot.png', filesize: 2048, data: 'abc123' });
  console.assert(imgMeta.type     === 'image',       'extractMediaMetadata: image type');
  console.assert(imgMeta.mimeType === 'image/png',   'extractMediaMetadata: image mimeType');
  console.assert(imgMeta.filename === 'screenshot.png', 'extractMediaMetadata: image filename');
  console.assert(imgMeta.filesize === 2048,          'extractMediaMetadata: image filesize');
  console.assert(imgMeta.data     === 'abc123',      'extractMediaMetadata: image data');

  const pdfMeta = extractMediaMetadata({ filename: 'report.pdf', data: 'pdfdata' });
  console.assert(pdfMeta.type     === 'pdf',             'extractMediaMetadata: pdf type via ext');
  console.assert(pdfMeta.mimeType === 'application/pdf', 'extractMediaMetadata: pdf mimeType via ext');

  const unknownMeta = extractMediaMetadata({ mimetype: 'video/mp4', filename: 'clip.mp4' });
  console.assert(unknownMeta.type === 'unsupported',     'extractMediaMetadata: unsupported type');
  console.log('PASS: MultimodalHandler extractMediaMetadata');

  // ── MultimodalHandler: content block builders ─────────────────────────────
  const imgBlock = buildImageBlock({ mimeType: 'image/jpeg', data: 'base64data' });
  console.assert(imgBlock.type                  === 'image',      'buildImageBlock: type');
  console.assert(imgBlock.source.type           === 'base64',     'buildImageBlock: source type');
  console.assert(imgBlock.source.media_type     === 'image/jpeg', 'buildImageBlock: media_type');
  console.assert(imgBlock.source.data           === 'base64data', 'buildImageBlock: data');

  const pdfBlock = buildPdfBlock({ mimeType: 'application/pdf', data: 'pdfbase64', filename: 'doc.pdf' });
  console.assert(pdfBlock.type              === 'document',         'buildPdfBlock: type');
  console.assert(pdfBlock.source.media_type === 'application/pdf',  'buildPdfBlock: media_type');
  console.log('PASS: MultimodalHandler content block builders');

  // ── MultimodalHandler: buildContentBlocksFromAttachments ─────────────────
  const attachments = [
    { mimetype: 'image/jpeg', data: 'imgdata' },
    { mimetype: 'application/pdf', data: 'pdfdata' },
    { mimetype: 'video/mp4', data: 'videodata' },  // should be skipped
    { mimetype: 'image/png' },                       // no data — should be skipped
  ];
  const blocks = buildContentBlocksFromAttachments(attachments);
  console.assert(blocks.length === 2,              'buildContentBlocksFromAttachments: 2 blocks (skips unsupported/no-data)');
  console.assert(blocks[0].type === 'image',       'buildContentBlocksFromAttachments: first block is image');
  console.assert(blocks[1].type === 'document',    'buildContentBlocksFromAttachments: second block is document');
  console.log('PASS: MultimodalHandler buildContentBlocksFromAttachments');

  // ── LinkProcessor: extractUrls ────────────────────────────────────────────
  const urls1 = extractUrls('Check https://example.com and www.foo.org for details');
  console.assert(urls1.length === 2,                           'extractUrls: finds 2 urls');
  console.assert(urls1.includes('https://example.com'),        'extractUrls: https url present');
  console.assert(urls1.includes('https://www.foo.org'),        'extractUrls: www normalised to https');

  const urls2 = extractUrls('No links here!');
  console.assert(urls2.length === 0,                           'extractUrls: empty when no links');

  const urls3 = extractUrls('Dup: https://dup.com https://dup.com');
  console.assert(urls3.length === 1,                           'extractUrls: deduplicates');
  console.log('PASS: LinkProcessor extractUrls');

  // ── LinkProcessor: isValidUrl ─────────────────────────────────────────────
  console.assert(isValidUrl('https://example.com') === true,  'isValidUrl: https valid');
  console.assert(isValidUrl('http://foo.bar/path') === true,   'isValidUrl: http valid');
  console.assert(isValidUrl('ftp://files.example') === false,  'isValidUrl: ftp invalid');
  console.assert(isValidUrl('not-a-url')           === false,  'isValidUrl: garbage invalid');
  console.assert(isValidUrl('')                    === false,  'isValidUrl: empty string invalid');
  console.log('PASS: LinkProcessor isValidUrl');

  // ── LinkProcessor: categoriseContentType ─────────────────────────────────
  console.assert(categoriseContentType('text/html; charset=utf-8') === 'text',  'categorise: html → text');
  console.assert(categoriseContentType('application/json')         === 'text',  'categorise: json → text');
  console.assert(categoriseContentType('image/png')                === 'image', 'categorise: png → image');
  console.assert(categoriseContentType('application/pdf')          === 'pdf',   'categorise: pdf → pdf');
  console.assert(categoriseContentType('video/mp4')                === 'other', 'categorise: video → other');
  console.assert(categoriseContentType('')                         === 'other', 'categorise: empty → other');
  console.log('PASS: LinkProcessor categoriseContentType');

  // ── MessagingLayer: buildMessage multimodal fields ────────────────────────
  const mediaAttachments = [{ type: 'image/jpeg', url: 'https://cdn.example.com/img.jpg', caption: null, filename: 'img.jpg', size: 1024 }];
  const linkObjects      = [{ url: 'https://github.com', title: 'GitHub', description: null }];

  const msg = buildMessage({ userId: 'test@c.us', text: 'Look at this https://github.com', media: mediaAttachments, links: linkObjects });
  console.assert(msg.userId             === 'test@c.us',          'buildMessage: userId');
  console.assert(msg.media.length       === 1,                    'buildMessage: media populated');
  console.assert(msg.media[0].type      === 'image/jpeg',         'buildMessage: media type');
  console.assert(msg.links.length       === 1,                    'buildMessage: links populated');
  console.assert(msg.links[0].url       === 'https://github.com', 'buildMessage: link url');
  console.assert(msg.isConfirmation     === false,                 'buildMessage: not a confirmation');

  const msgNoMultimodal = buildMessage({ userId: 'a@c.us', text: 'plain text' });
  console.assert(Array.isArray(msgNoMultimodal.media) && msgNoMultimodal.media.length === 0, 'buildMessage: media defaults to []');
  console.assert(Array.isArray(msgNoMultimodal.links) && msgNoMultimodal.links.length === 0, 'buildMessage: links defaults to []');
  console.log('PASS: MessagingLayer buildMessage multimodal fields');

  // ── ContextAgent: multimodal append + getContextBlock ────────────────────
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-test-'));
  const ctxAgent = new ContextAgent();

  ctxAgent.append(tmpDir, 'user', 'Here is an image', {
    media: [{ type: 'image', mimeType: 'image/jpeg', filename: 'photo.jpg', filesize: 51200, data: 'base64...' }],
    links: [],
  });
  ctxAgent.append(tmpDir, 'user', 'Check this link', {
    media: [],
    links: [{ url: 'https://example.com', category: 'text', textContent: 'Example Domain home page content', error: null }],
  });
  ctxAgent.append(tmpDir, 'assistant', 'I see the image and the link.');

  const block = ctxAgent.getContextBlock(tmpDir);
  console.assert(block.includes('Previous conversation context'), 'ContextAgent: block header present');
  console.assert(block.includes('photo.jpg'),                     'ContextAgent: media filename in block');
  console.assert(block.includes('[image'),                        'ContextAgent: media type tag in block');
  console.assert(block.includes('50KB'),                          'ContextAgent: media size in block');
  console.assert(block.includes('https://example.com'),           'ContextAgent: link url in block');
  console.assert(block.includes('Example Domain'),                'ContextAgent: link text snippet in block');
  console.assert(block.includes('I see the image'),               'ContextAgent: assistant turn present');

  // history trimming: verify only last MAX_HISTORY entries are kept
  for (let i = 0; i < 12; i++) ctxAgent.append(tmpDir, 'user', `msg ${i}`);
  const historyFile = path.join(tmpDir, '.rea-context.json');
  const saved = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
  console.assert(saved.length <= 10, `ContextAgent: history trimmed to ≤10 (got ${saved.length})`);

  // cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('PASS: ContextAgent multimodal append and getContextBlock');

  // ── ClaudeCodeExecutor: buildMultimodalBlocks ────────────────────────────
  // null / undefined / empty → no blocks
  console.assert(buildMultimodalBlocks(null).length      === 0, 'buildMultimodalBlocks: null → []');
  console.assert(buildMultimodalBlocks(undefined).length === 0, 'buildMultimodalBlocks: undefined → []');
  console.assert(buildMultimodalBlocks({}).length        === 0, 'buildMultimodalBlocks: empty → []');

  // Image attachment → image block
  const mmImgBlocks = buildMultimodalBlocks({
    attachments: [{ mimetype: 'image/jpeg', data: 'abc', filename: 'test.jpg' }],
    links: [],
  });
  console.assert(mmImgBlocks.length    === 1,       'buildMultimodalBlocks: 1 image → 1 block');
  console.assert(mmImgBlocks[0].type   === 'image',  'buildMultimodalBlocks: image block type');

  // PDF attachment → document block
  const mmPdfBlocks = buildMultimodalBlocks({
    attachments: [{ mimetype: 'application/pdf', data: 'pdfdata', filename: 'doc.pdf' }],
    links: [],
  });
  console.assert(mmPdfBlocks.length    === 1,          'buildMultimodalBlocks: 1 pdf → 1 block');
  console.assert(mmPdfBlocks[0].type   === 'document',  'buildMultimodalBlocks: document block type');

  // Text link with fetched content → text block containing URL and snippet
  const mmLinkBlocks = buildMultimodalBlocks({
    attachments: [],
    links: [{ url: 'https://example.com', valid: true, category: 'text', textContent: 'Hello world', error: null }],
  });
  console.assert(mmLinkBlocks.length === 1,                                'buildMultimodalBlocks: text link → 1 block');
  console.assert(mmLinkBlocks[0].type === 'text',                           'buildMultimodalBlocks: link becomes text block');
  console.assert(mmLinkBlocks[0].text.includes('https://example.com'),      'buildMultimodalBlocks: link url in text');
  console.assert(mmLinkBlocks[0].text.includes('Hello world'),              'buildMultimodalBlocks: link content in text');

  // Non-text link (image URL) → text block with content-type metadata
  const mmNonTextLink = buildMultimodalBlocks({
    attachments: [],
    links: [{ url: 'https://cdn.example.com/photo.jpg', valid: true, category: 'image', contentType: 'image/jpeg', error: null }],
  });
  console.assert(mmNonTextLink.length === 1,                                  'buildMultimodalBlocks: non-text link → 1 block');
  console.assert(mmNonTextLink[0].text.includes('image/jpeg'),                 'buildMultimodalBlocks: non-text link has content-type');

  // Invalid or errored links are skipped
  const mmSkipped = buildMultimodalBlocks({
    attachments: [],
    links: [
      { url: 'https://bad.url', valid: false, category: 'text', textContent: 'should skip', error: null },
      { url: 'https://err.url', valid: true,  category: 'text', textContent: 'should skip', error: 'fetch failed' },
    ],
  });
  console.assert(mmSkipped.length === 0, 'buildMultimodalBlocks: invalid/errored links skipped');

  // Combined: image attachment + text link → 2 blocks in order
  const mmCombined = buildMultimodalBlocks({
    attachments: [{ mimetype: 'image/png', data: 'imgdata', filename: 'shot.png' }],
    links: [{ url: 'https://docs.example.com', valid: true, category: 'text', textContent: 'docs content', error: null }],
  });
  console.assert(mmCombined.length    === 2,        'buildMultimodalBlocks: image + link → 2 blocks');
  console.assert(mmCombined[0].type   === 'image',   'buildMultimodalBlocks: combined first block is image');
  console.assert(mmCombined[1].type   === 'text',    'buildMultimodalBlocks: combined second block is text');
  console.log('PASS: ClaudeCodeExecutor buildMultimodalBlocks');

  // ── PlanningAgent: media forwarded to executor.run() ─────────────────────
  let plannerRunMedia = null;
  const plannerCapturingExec = {
    budgetStatus: mockBudget,
    extendBudget: () => {},
    run: async (prompt, repoPath, opts) => {
      plannerRunMedia = opts?.media ?? null;
      return { success: true, output: '1. Create utils/foo.js', budget: mockBudget, exitCode: 0 };
    },
  };
  const plannerWithMedia = new PlanningAgent(plannerCapturingExec);
  const plannerTestMedia = {
    attachments: [],
    links: [{ url: 'https://spec.example.com', valid: true, category: 'text', textContent: 'spec content', error: null }],
  };
  await plannerWithMedia.plan('Build a CSV exporter', '/fake/path', null, { media: plannerTestMedia });
  console.assert(plannerRunMedia !== null,             'PlanningAgent: media passed to executor');
  console.assert(plannerRunMedia === plannerTestMedia, 'PlanningAgent: correct media object passed to executor');
  console.log('PASS: PlanningAgent forwards media to executor.run()');

  // ── ExecutionAgent: media forwarded to executor.run() ────────────────────
  let execRunMedia = null;
  const execCapturingExec = {
    budgetStatus: mockBudget,
    extendBudget: () => {},
    run: async (prompt, repoPath, opts) => {
      execRunMedia = opts?.media ?? null;
      return { success: true, output: 'Done', budget: mockBudget, exitCode: 0 };
    },
  };
  const execWithMedia = new ExecutionAgent(execCapturingExec);
  const execTestMedia = { attachments: [{ mimetype: 'image/png', data: 'data', filename: 'screen.png' }], links: [] };
  await execWithMedia.code('Implement the feature shown in the image', '/fake/path', null, [], execTestMedia);
  console.assert(execRunMedia !== null,           'ExecutionAgent: media passed to executor');
  console.assert(execRunMedia === execTestMedia,  'ExecutionAgent: correct media object passed to executor');
  console.log('PASS: ExecutionAgent forwards media to executor.run()');

  // ── OrchestratorAgent: multimodal context flows to execution ─────────────
  // Uses a simple task (starts with "add", ≤12 words) so planning is skipped
  // and execution.code() is called directly — allowing us to verify media propagation.
  // Planning-side media propagation is covered by the PlanningAgent unit test above.
  let orchExecMedia  = null;
  const orchMMMessages = [];
  const orchMMAgents = {
    executor:  fakeExec,
    planning:  new PlanningAgent(fakeExec),
    execution: new ExecutionAgent(fakeExec),
    debugging: new DebuggingAgent(fakeExec),
    review:    new ReviewAgent(fakeExec),
    logging:   new LoggingAgent(),
  };
  orchMMAgents.execution.code = async (task, repoPath, onProgress, steps, media) => {
    orchExecMedia = media;
    return { success: true, output: 'Done', budget: mockBudget, exitCode: 0 };
  };
  orchMMAgents.execution.test  = async () => ({ passed: true, passedCount: 1, failedCount: 0, details: '', rawOutput: '', budget: mockBudget, executorSuccess: true });
  orchMMAgents.review.review   = async () => ({ passed: true, verdict: 'PASS', reasons: '', diff: '', budget: mockBudget });

  const orchMM = new OrchestratorAgent(orchMMAgents, async (uid, msg) => orchMMMessages.push(msg));
  const orchMMMedia = { attachments: [{ mimetype: 'image/jpeg', data: 'x', filename: 'img.jpg' }], links: [] };
  // "add screenshot handler" → simple task (_isSimpleTask returns true), skips planning → goes straight to coding
  orchMM.startTask('mm@c.us', 'add screenshot handler', '/fake/path', null, orchMMMedia);
  await new Promise(r => setTimeout(r, 500));

  console.assert(orchExecMedia !== null,        'OrchestratorAgent multimodal: media passed to execution');
  console.assert(orchExecMedia === orchMMMedia, 'OrchestratorAgent multimodal: same media object to execution');
  console.assert(orchMMMessages.some(m => m.includes('Tests passed')), 'OrchestratorAgent multimodal: pipeline reaches testing stage');
  console.log('PASS: OrchestratorAgent multimodal context flows to execution');

  // ── IntentAgent: multimodal context summarised in classification prompt ───
  let intentPromptCapture = null;
  const intentAgent = new IntentAgent();
  intentAgent._executor.run = async (prompt) => {
    intentPromptCapture = prompt;
    return { success: true, output: 'TASK', budget: mockBudget, exitCode: 0 };
  };
  const intentMultimodal = {
    media: [{ mimeType: 'image/jpeg', type: 'image' }],
    links: [{ url: 'https://jira.example.com/TICKET-123' }],
  };
  const intentResult = await intentAgent.classify('Fix the bug shown in the screenshot', { multimodal: intentMultimodal });
  console.assert(intentResult === 'TASK',                                       'IntentAgent multimodal: returns TASK');
  console.assert(intentPromptCapture.includes('image/jpeg'),                    'IntentAgent multimodal: media MIME type in prompt');
  console.assert(intentPromptCapture.includes('https://jira.example.com/TICKET-123'), 'IntentAgent multimodal: link url in prompt');
  console.log('PASS: IntentAgent multimodal context summarised in classification prompt');

  console.log('\nAll agent tests passed.');
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });

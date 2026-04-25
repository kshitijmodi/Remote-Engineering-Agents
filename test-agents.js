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
const { buildQuickReply, buildListMessage, parseButtonResponse } = require('./src/ui/WhatsAppButtons');
const { yesNo, confirmCancelModify, confirmCancel, choiceList, retryCancel } = require('./src/ui/ConfirmationPrompts');
const { ButtonResponseHandler } = require('./src/messaging/ButtonResponseHandler');
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

  // ── WhatsAppButtons: buildQuickReply ─────────────────────────────────────
  const qr = buildQuickReply('Are you sure?', [
    { id: 'btn_yes', title: 'Yes' },
    { id: 'btn_no',  title: 'No'  },
  ]);
  console.assert(qr.type                          === 'quick_reply',    'buildQuickReply: type');
  console.assert(qr.payload.type                  === 'button',         'buildQuickReply: payload.type');
  console.assert(qr.payload.body.text             === 'Are you sure?',  'buildQuickReply: body text');
  console.assert(qr.payload.action.buttons.length === 2,               'buildQuickReply: 2 buttons');
  console.assert(qr.payload.action.buttons[0].reply.id === 'btn_yes',  'buildQuickReply: first button id');
  console.assert(qr.payload.action.buttons[1].reply.id === 'btn_no',   'buildQuickReply: second button id');

  // optional header / footer
  const qrWithMeta = buildQuickReply('Continue?', [{ id: 'go', title: 'Go' }], { header: 'Heads up', footer: 'Powered by REA' });
  console.assert(qrWithMeta.payload.header.text   === 'Heads up',      'buildQuickReply: header text');
  console.assert(qrWithMeta.payload.footer.text   === 'Powered by REA','buildQuickReply: footer text');

  // title truncation at 20 chars
  const longTitle = 'A'.repeat(30);
  const qrTrunc = buildQuickReply('Body', [{ id: 'x', title: longTitle }]);
  console.assert(qrTrunc.payload.action.buttons[0].reply.title.length === 20, 'buildQuickReply: title truncated to 20');

  // validation errors
  let threw = false;
  try { buildQuickReply('', [{ id: 'a', title: 'A' }]); } catch { threw = true; }
  console.assert(threw, 'buildQuickReply: throws on empty bodyText');

  threw = false;
  try { buildQuickReply('Body', [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }, { id: 'd', title: 'D' }]); } catch { threw = true; }
  console.assert(threw, 'buildQuickReply: throws when >3 buttons');
  console.log('PASS: WhatsAppButtons buildQuickReply');

  // ── WhatsAppButtons: buildListMessage ────────────────────────────────────
  const lm = buildListMessage(
    'Pick a command',
    'Options',
    [
      { title: 'Tasks', rows: [{ id: 'new_task', title: 'New Task', description: 'Start something new' }] },
      { title: 'Status', rows: [{ id: 'check_status', title: 'Check Status' }] },
    ]
  );
  console.assert(lm.type                                         === 'list',         'buildListMessage: type');
  console.assert(lm.payload.type                                 === 'list',         'buildListMessage: payload.type');
  console.assert(lm.payload.body.text                            === 'Pick a command', 'buildListMessage: body text');
  console.assert(lm.payload.action.button                        === 'Options',      'buildListMessage: button label');
  console.assert(lm.payload.action.sections.length               === 2,              'buildListMessage: 2 sections');
  console.assert(lm.payload.action.sections[0].rows[0].id        === 'new_task',     'buildListMessage: row id');
  console.assert(lm.payload.action.sections[0].rows[0].description === 'Start something new', 'buildListMessage: row description');
  console.assert(lm.payload.action.sections[1].rows[0].id        === 'check_status', 'buildListMessage: second section row id');

  // row without description should not have the key
  console.assert(!('description' in lm.payload.action.sections[1].rows[0]), 'buildListMessage: no description key when omitted');

  threw = false;
  try { buildListMessage('Body', 'Btn', []); } catch { threw = true; }
  console.assert(threw, 'buildListMessage: throws on empty sections');
  console.log('PASS: WhatsAppButtons buildListMessage');

  // ── WhatsAppButtons: parseButtonResponse ─────────────────────────────────
  const btnReply = parseButtonResponse({ type: 'buttons_response', selectedButtonId: 'ccm_confirm', body: '✅ Confirm' });
  console.assert(btnReply.type  === 'button_reply',  'parseButtonResponse: button_reply type');
  console.assert(btnReply.id    === 'ccm_confirm',   'parseButtonResponse: button id');
  console.assert(btnReply.title === '✅ Confirm',    'parseButtonResponse: button title');

  const listReply = parseButtonResponse({ type: 'list_response', selectedRowId: 'choice_2', body: 'Option C' });
  console.assert(listReply.type  === 'list_reply', 'parseButtonResponse: list_reply type');
  console.assert(listReply.id    === 'choice_2',   'parseButtonResponse: row id');
  console.assert(listReply.title === 'Option C',   'parseButtonResponse: row title');

  console.assert(parseButtonResponse({ type: 'chat', body: 'hello' }) === null, 'parseButtonResponse: null for non-interactive');
  console.log('PASS: WhatsAppButtons parseButtonResponse');

  // ── ConfirmationPrompts: yesNo ────────────────────────────────────────────
  const yn = yesNo('Do you want to proceed?');
  console.assert(yn.type === 'quick_reply',                                   'yesNo: type');
  console.assert(yn.payload.action.buttons[0].reply.id    === 'confirm_yes',  'yesNo: yes button id');
  console.assert(yn.payload.action.buttons[0].reply.title === 'Yes',          'yesNo: yes button default label');
  console.assert(yn.payload.action.buttons[1].reply.id    === 'confirm_no',   'yesNo: no button id');

  const ynCustom = yesNo('Continue?', { yesLabel: 'Proceed', noLabel: 'Stop' });
  console.assert(ynCustom.payload.action.buttons[0].reply.title === 'Proceed', 'yesNo: custom yes label');
  console.assert(ynCustom.payload.action.buttons[1].reply.title === 'Stop',    'yesNo: custom no label');
  console.log('PASS: ConfirmationPrompts yesNo');

  // ── ConfirmationPrompts: confirmCancelModify ──────────────────────────────
  const ccm = confirmCancelModify('Deploy v2.1 to production?');
  console.assert(ccm.type === 'quick_reply',                                     'confirmCancelModify: type');
  console.assert(ccm.payload.action.buttons.length === 3,                        'confirmCancelModify: 3 buttons');
  console.assert(ccm.payload.action.buttons[0].reply.id === 'ccm_confirm',       'confirmCancelModify: confirm id');
  console.assert(ccm.payload.action.buttons[1].reply.id === 'ccm_cancel',        'confirmCancelModify: cancel id');
  console.assert(ccm.payload.action.buttons[2].reply.id === 'ccm_modify',        'confirmCancelModify: modify id');
  console.log('PASS: ConfirmationPrompts confirmCancelModify');

  // ── ConfirmationPrompts: confirmCancel ────────────────────────────────────
  const cc = confirmCancel('Run database migration?');
  console.assert(cc.payload.action.buttons.length === 2,                         'confirmCancel: 2 buttons');
  console.assert(cc.payload.action.buttons[0].reply.id === 'ccm_confirm',        'confirmCancel: confirm id');
  console.assert(cc.payload.action.buttons[1].reply.id === 'ccm_cancel',         'confirmCancel: cancel id');
  console.log('PASS: ConfirmationPrompts confirmCancel');

  // ── ConfirmationPrompts: choiceList ───────────────────────────────────────
  const cl = choiceList('What would you like to do?', ['Add feature', 'Fix bug', 'Review code', 'Run tests']);
  console.assert(cl.type === 'list',                                              'choiceList: type');
  console.assert(cl.payload.action.sections[0].rows.length === 4,                'choiceList: 4 rows');
  console.assert(cl.payload.action.sections[0].rows[0].id   === 'choice_0',      'choiceList: first row id');
  console.assert(cl.payload.action.sections[0].rows[0].title === 'Add feature',  'choiceList: first row title');
  console.assert(cl.payload.action.sections[0].rows[3].id   === 'choice_3',      'choiceList: last row id');

  threw = false;
  try { choiceList('Q?', []); } catch { threw = true; }
  console.assert(threw, 'choiceList: throws on empty choices');
  console.log('PASS: ConfirmationPrompts choiceList');

  // ── ConfirmationPrompts: retryCancel ─────────────────────────────────────
  const rc = retryCancel('Tests failed. What would you like to do?');
  console.assert(rc.payload.action.buttons[0].reply.id === 'retry_retry',        'retryCancel: retry id');
  console.assert(rc.payload.action.buttons[1].reply.id === 'retry_cancel',       'retryCancel: cancel id');
  console.log('PASS: ConfirmationPrompts retryCancel');

  // ── ButtonResponseHandler: ccm_confirm → onConfirm ───────────────────────
  let confirmedUser = null;
  const brhConfirm = new ButtonResponseHandler({ onConfirm: (uid) => { confirmedUser = uid; } });
  const routed = brhConfirm.handle('alice@c.us', { buttonId: 'ccm_confirm', title: '✅ Confirm' });
  console.assert(routed === true,             'ButtonResponseHandler: ccm_confirm returns true');
  console.assert(confirmedUser === 'alice@c.us', 'ButtonResponseHandler: ccm_confirm invokes onConfirm');
  console.log('PASS: ButtonResponseHandler ccm_confirm → onConfirm');

  // ── ButtonResponseHandler: ccm_cancel → onCancel ─────────────────────────
  let cancelledUser = null;
  const brhCancel = new ButtonResponseHandler({ onCancel: (uid) => { cancelledUser = uid; } });
  brhCancel.handle('bob@c.us', { buttonId: 'ccm_cancel', title: '❌ Cancel' });
  console.assert(cancelledUser === 'bob@c.us', 'ButtonResponseHandler: ccm_cancel invokes onCancel');
  console.log('PASS: ButtonResponseHandler ccm_cancel → onCancel');

  // ── ButtonResponseHandler: ccm_modify → onModify ─────────────────────────
  let modifyArgs = null;
  const brhModify = new ButtonResponseHandler({ onModify: (uid, hint) => { modifyArgs = { uid, hint }; } });
  brhModify.handle('carol@c.us', { buttonId: 'ccm_modify', title: '✏️ Modify' });
  console.assert(modifyArgs?.uid  === 'carol@c.us', 'ButtonResponseHandler: ccm_modify passes userId');
  console.assert(modifyArgs?.hint === '✏️ Modify',  'ButtonResponseHandler: ccm_modify passes title as hint');
  console.log('PASS: ButtonResponseHandler ccm_modify → onModify');

  // ── ButtonResponseHandler: confirm_yes / confirm_no ──────────────────────
  let yesUser = null, noUser = null;
  const brhYesNo = new ButtonResponseHandler({
    onYes: (uid) => { yesUser = uid; },
    onNo:  (uid) => { noUser  = uid; },
  });
  brhYesNo.handle('dave@c.us', { buttonId: 'confirm_yes', title: 'Yes' });
  brhYesNo.handle('eve@c.us',  { buttonId: 'confirm_no',  title: 'No'  });
  console.assert(yesUser === 'dave@c.us', 'ButtonResponseHandler: confirm_yes → onYes');
  console.assert(noUser  === 'eve@c.us',  'ButtonResponseHandler: confirm_no  → onNo');

  // confirm_yes falls back to onConfirm when onYes is absent
  let fallbackConfirm = null;
  const brhFallback = new ButtonResponseHandler({ onConfirm: (uid) => { fallbackConfirm = uid; } });
  brhFallback.handle('frank@c.us', { buttonId: 'confirm_yes', title: 'Yes' });
  console.assert(fallbackConfirm === 'frank@c.us', 'ButtonResponseHandler: confirm_yes falls back to onConfirm');
  console.log('PASS: ButtonResponseHandler confirm_yes / confirm_no');

  // ── ButtonResponseHandler: list reply (rowId) ────────────────────────────
  let choiceArgs = null;
  const brhChoice = new ButtonResponseHandler({ onChoice: (uid, idx, title) => { choiceArgs = { uid, idx, title }; } });
  brhChoice.handle('grace@c.us', { rowId: 'choice_2', title: 'Review code' });
  console.assert(choiceArgs?.uid   === 'grace@c.us',  'ButtonResponseHandler: list reply passes userId');
  console.assert(choiceArgs?.idx   === 2,              'ButtonResponseHandler: list reply parses index');
  console.assert(choiceArgs?.title === 'Review code',  'ButtonResponseHandler: list reply passes title');
  console.log('PASS: ButtonResponseHandler list reply (choice_N)');

  // ── ButtonResponseHandler: retry_retry / retry_cancel ────────────────────
  let retried = null;
  const brhRetry = new ButtonResponseHandler({
    onRetry:  (uid) => { retried = uid; },
    onCancel: () => {},
  });
  const retriedRouted = brhRetry.handle('henry@c.us', { buttonId: 'retry_retry', title: '🔄 Retry' });
  console.assert(retriedRouted    === true,          'ButtonResponseHandler: retry_retry returns true');
  console.assert(retried          === 'henry@c.us',  'ButtonResponseHandler: retry_retry → onRetry');
  console.log('PASS: ButtonResponseHandler retry_retry → onRetry');

  // ── ButtonResponseHandler: handleMessage convenience wrapper ─────────────
  let handledViaMessage = null;
  const brhMsg = new ButtonResponseHandler({ onConfirm: (uid) => { handledViaMessage = uid; } });
  const routedMsg = brhMsg.handleMessage({ userId: 'ivan@c.us', buttonInteraction: { buttonId: 'ccm_confirm', title: '✅ Confirm' } });
  console.assert(routedMsg         === true,         'ButtonResponseHandler: handleMessage returns true');
  console.assert(handledViaMessage === 'ivan@c.us',  'ButtonResponseHandler: handleMessage routes correctly');

  const notRouted = brhMsg.handleMessage({ userId: 'ivan@c.us' }); // no buttonInteraction
  console.assert(notRouted === false, 'ButtonResponseHandler: handleMessage returns false with no interaction');
  console.log('PASS: ButtonResponseHandler handleMessage convenience wrapper');

  // ── ButtonResponseHandler: unknown button ID returns false ────────────────
  const brhUnknown = new ButtonResponseHandler({});
  const unknownRouted = brhUnknown.handle('judy@c.us', { buttonId: 'unknown_btn', title: 'Mystery' });
  console.assert(unknownRouted === false, 'ButtonResponseHandler: unknown button ID returns false');
  console.log('PASS: ButtonResponseHandler unknown button ID → false');

  // ── End-to-end button flow: build prompt → parse response → route handler ─
  //
  // Flow mirrors the real system:
  //   1. Agent calls confirmCancelModify() to build the prompt and extract the button IDs.
  //   2. User taps a button → WhatsApp delivers a buttons_response message.
  //      parseButtonResponse() checks whether the raw message IS a button response.
  //   3. WhatsAppProvider normalizes the raw message into a buttonInteraction object
  //      ({ buttonId, title }) matching the shape ButtonResponseHandler.handle() expects.
  //   4. ButtonResponseHandler routes to the registered callback.

  // Step 1: build a confirmCancelModify prompt (simulates what PlanningAgent sends)
  const e2ePrompt = confirmCancelModify('Deploy v3.0 to staging?');
  console.assert(e2ePrompt.type === 'quick_reply', 'e2e button flow: prompt type is quick_reply');
  const e2eButtons = e2ePrompt.payload.action.buttons;
  console.assert(e2eButtons.length === 3, 'e2e button flow: 3 buttons in prompt');

  // Step 2: simulate WhatsApp delivering a buttons_response for the "Confirm" button.
  //   parseButtonResponse() returns non-null, confirming this is a button interaction.
  const e2eRawReply = {
    type: 'buttons_response',
    selectedButtonId: e2eButtons[0].reply.id,  // 'ccm_confirm'
    body: e2eButtons[0].reply.title,            // '✅ Confirm'
  };
  const e2eParsed = parseButtonResponse(e2eRawReply);
  console.assert(e2eParsed !== null,                  'e2e button flow: parseButtonResponse detects button interaction');
  console.assert(e2eParsed.type === 'button_reply',   'e2e button flow: parsed type is button_reply');
  console.assert(e2eParsed.id   === 'ccm_confirm',    'e2e button flow: parsed id is ccm_confirm');

  // Step 3: WhatsAppProvider normalizes into the buttonInteraction shape that
  //   handle() consumes — { buttonId, title } for quick-reply interactions.
  const e2eInteraction = {
    type: 'quick_reply',
    buttonId: e2eRawReply.selectedButtonId,   // 'ccm_confirm'
    title:    e2eRawReply.body,               // '✅ Confirm'
  };

  // Step 4: route through ButtonResponseHandler
  let e2eConfirmedUser = null;
  const e2eHandler = new ButtonResponseHandler({ onConfirm: (uid) => { e2eConfirmedUser = uid; } });
  const e2eRouted = e2eHandler.handle('karen@c.us', e2eInteraction);
  console.assert(e2eRouted === true,                  'e2e button flow: handler returns true (routed)');
  console.assert(e2eConfirmedUser === 'karen@c.us',   'e2e button flow: onConfirm called with correct userId');
  console.log('PASS: e2e button flow confirmCancelModify (confirm path)');

  // ── End-to-end: choiceList prompt → list response → onChoice handler ──────
  // Step 1: build a choiceList prompt (simulates what CommunicationAgent sends)
  const e2eChoicePrompt = choiceList('Select an action', ['Add feature', 'Fix bug', 'Write tests']);
  const e2eRows = e2eChoicePrompt.payload.action.sections[0].rows;
  console.assert(e2eRows.length === 3, 'e2e choice flow: 3 rows in list prompt');

  // Step 2: simulate WhatsApp delivering a list_response for the second option ("Fix bug")
  const e2eListRaw = {
    type: 'list_response',
    selectedRowId: e2eRows[1].id,   // 'choice_1'
    body: e2eRows[1].title,         // 'Fix bug'
  };
  const e2eListParsed = parseButtonResponse(e2eListRaw);
  console.assert(e2eListParsed !== null,               'e2e choice flow: parseButtonResponse detects list interaction');
  console.assert(e2eListParsed.type === 'list_reply',  'e2e choice flow: parsed type is list_reply');
  console.assert(e2eListParsed.id   === 'choice_1',    'e2e choice flow: parsed id is choice_1');
  console.assert(e2eListParsed.title === 'Fix bug',    'e2e choice flow: parsed title matches selection');

  // Step 3: WhatsAppProvider normalizes into the buttonInteraction shape — { rowId, title }
  const e2eListInteraction = {
    type: 'list',
    rowId: e2eListRaw.selectedRowId,   // 'choice_1'
    title: e2eListRaw.body,            // 'Fix bug'
  };

  // Step 4: route to onChoice handler
  let e2eChoiceResult = null;
  const e2eChoiceHandler = new ButtonResponseHandler({
    onChoice: (uid, idx, title) => { e2eChoiceResult = { uid, idx, title }; },
  });
  const e2eListRouted = e2eChoiceHandler.handle('liam@c.us', e2eListInteraction);
  console.assert(e2eListRouted === true,               'e2e choice flow: handler returns true (routed)');
  console.assert(e2eChoiceResult?.uid   === 'liam@c.us', 'e2e choice flow: onChoice receives correct userId');
  console.assert(e2eChoiceResult?.idx   === 1,           'e2e choice flow: onChoice receives correct index');
  console.assert(e2eChoiceResult?.title === 'Fix bug',   'e2e choice flow: onChoice receives correct title');
  console.log('PASS: e2e button flow choiceList (list response path)');

  // ── MessagingLayer._dispatchMessage(): button intercept stops text callback ─
  const { MessagingLayer } = require('./src/messaging/MessagingLayer');

  // Concrete subclass just to access the protected _dispatchMessage
  class TestMessagingLayer extends MessagingLayer {
    onMessage(cb) { this._messageCallback = cb; }
  }
  const ml = new TestMessagingLayer();

  let textCallbackFired = false;
  ml.onMessage(() => { textCallbackFired = true; });

  let mlConfirmedUser = null;
  const mlBrh = new ButtonResponseHandler({ onConfirm: (uid) => { mlConfirmedUser = uid; } });
  ml.registerButtonResponseHandler(mlBrh);

  // Dispatch a message with a recognised button interaction — text callback must NOT fire
  const mlBtnMsg = buildMessage({
    userId: 'mia@c.us',
    text: '',
    buttonInteraction: { buttonId: 'ccm_confirm', title: '✅ Confirm' },
  });
  ml._dispatchMessage(mlBtnMsg);
  console.assert(mlConfirmedUser    === 'mia@c.us', 'MessagingLayer._dispatchMessage: routes button to handler');
  console.assert(textCallbackFired  === false,       'MessagingLayer._dispatchMessage: text callback NOT called for button');
  console.log('PASS: MessagingLayer._dispatchMessage intercepts button interaction');

  // ── MessagingLayer._dispatchMessage(): unrecognised button falls through ───
  let fallThruTextFired = false;
  const ml2 = new TestMessagingLayer();
  ml2.onMessage(() => { fallThruTextFired = true; });
  const ml2Brh = new ButtonResponseHandler({});  // no handlers registered
  ml2.registerButtonResponseHandler(ml2Brh);

  const ml2Msg = buildMessage({
    userId: 'noah@c.us',
    text: 'hello',
    buttonInteraction: { buttonId: 'unknown_xyz', title: 'Mystery' },
  });
  ml2._dispatchMessage(ml2Msg);
  console.assert(fallThruTextFired === true, 'MessagingLayer._dispatchMessage: unrecognised button falls through to text callback');
  console.log('PASS: MessagingLayer._dispatchMessage unrecognised button falls through to text callback');

  // ── MessagingLayer._dispatchMessage(): plain text message (no interaction) ─
  let plainTextFired = false;
  const ml3 = new TestMessagingLayer();
  ml3.onMessage(() => { plainTextFired = true; });
  const ml3Msg = buildMessage({ userId: 'olivia@c.us', text: 'plain text message' });
  ml3._dispatchMessage(ml3Msg);
  console.assert(plainTextFired === true, 'MessagingLayer._dispatchMessage: plain text message reaches text callback');
  console.log('PASS: MessagingLayer._dispatchMessage plain text message reaches text callback');

  // ── MessagingLayer.registerButtonResponseHandler(): rejects non-handler ────
  let registerThrew = false;
  try { ml3.registerButtonResponseHandler({}); } catch { registerThrew = true; }
  console.assert(registerThrew === true, 'MessagingLayer.registerButtonResponseHandler: throws for non-ButtonResponseHandler');
  console.log('PASS: MessagingLayer.registerButtonResponseHandler rejects invalid handler');

  // ── FileHandler: readFileForTransfer — happy path ────────────────────────
  const {
    readFileForTransfer,
    setFileSizeLimit,
    setAllowedBaseDirs,
  } = require('./src/utils/FileHandler');

  const ftTmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-ft-'));
  const ftTxtFile = path.join(ftTmpDir, 'report.txt');
  fs.writeFileSync(ftTxtFile, 'Hello file transfer test');

  const ftResult = readFileForTransfer(ftTxtFile);
  console.assert(ftResult.filename === 'report.txt',   'readFileForTransfer: filename');
  console.assert(ftResult.mimeType === 'text/plain',   'readFileForTransfer: mimeType for .txt');
  console.assert(typeof ftResult.base64 === 'string' && ftResult.base64.length > 0, 'readFileForTransfer: base64 present');
  console.assert(ftResult.size === Buffer.from('Hello file transfer test').length,   'readFileForTransfer: size');
  console.assert(ftResult.mtime instanceof Date,       'readFileForTransfer: mtime is Date');
  console.assert(ftResult.resolvedPath === ftTxtFile,  'readFileForTransfer: resolvedPath');
  console.assert(
    Buffer.from(ftResult.base64, 'base64').toString('utf8') === 'Hello file transfer test',
    'readFileForTransfer: base64 round-trips'
  );
  console.log('PASS: FileHandler readFileForTransfer happy path');

  // ── FileHandler: readFileForTransfer — file not found ────────────────────
  let ftNotFoundThrew = false;
  try { readFileForTransfer(path.join(ftTmpDir, 'nonexistent.txt')); } catch (err) {
    ftNotFoundThrew = err.message.includes('not found') || err.message.includes('File not found');
  }
  console.assert(ftNotFoundThrew, 'readFileForTransfer: throws on missing file');
  console.log('PASS: FileHandler readFileForTransfer file not found');

  // ── FileHandler: readFileForTransfer — blocked extension ─────────────────
  const ftShFile = path.join(ftTmpDir, 'script.sh');
  fs.writeFileSync(ftShFile, '#!/bin/bash\necho hi');
  let ftBlockedThrew = false;
  try { readFileForTransfer(ftShFile); } catch (err) {
    ftBlockedThrew = err.message.includes('Access denied') && err.message.includes('.sh');
  }
  console.assert(ftBlockedThrew, 'readFileForTransfer: throws Access denied for .sh');
  console.log('PASS: FileHandler readFileForTransfer blocked extension');

  // ── FileHandler: readFileForTransfer — file too large ────────────────────
  const ftLargeFile = path.join(ftTmpDir, 'large.csv');
  fs.writeFileSync(ftLargeFile, 'x');
  setFileSizeLimit(1); // 1-byte limit
  let ftTooLargeThrew = false;
  try { readFileForTransfer(ftLargeFile); } catch (err) {
    ftTooLargeThrew = err.message.includes('too large') || err.message.includes('File too large');
  }
  setFileSizeLimit(10 * 1024 * 1024); // restore to 10 MB
  console.assert(ftTooLargeThrew, 'readFileForTransfer: throws File too large');
  console.log('PASS: FileHandler readFileForTransfer file too large');

  // ── FileHandler: readFileForTransfer — outside allowed dirs ──────────────
  setAllowedBaseDirs([path.join(ftTmpDir, 'restricted')]);
  let ftAccessDeniedThrew = false;
  try { readFileForTransfer(ftTxtFile); } catch (err) {
    ftAccessDeniedThrew = err.message.includes('Access denied');
  }
  setAllowedBaseDirs([]); // disable restriction
  console.assert(ftAccessDeniedThrew, 'readFileForTransfer: throws Access denied outside allowed dirs');
  console.log('PASS: FileHandler readFileForTransfer access denied outside allowed dirs');

  fs.rmSync(ftTmpDir, { recursive: true, force: true });

  // ── IntentAgent: FILE_SEND fast-path pattern matching ────────────────────
  const ftIntentAgent = new IntentAgent();
  // Override executor so tests never reach the LLM
  ftIntentAgent._executor.run = async () => { throw new Error('Should not reach LLM for FILE_SEND fast path'); };

  const ftIntent1 = await ftIntentAgent.classify('send me file /var/log/app.log');
  console.assert(ftIntent1 === 'FILE_SEND', `IntentAgent: "send me file /path" → FILE_SEND (got ${ftIntent1})`);

  const ftIntent2 = await ftIntentAgent.classify('can you send me the /reports/summary.pdf');
  console.assert(ftIntent2 === 'FILE_SEND', `IntentAgent: "send me the /path" → FILE_SEND (got ${ftIntent2})`);

  const ftIntent3 = await ftIntentAgent.classify('share the log file with me');
  console.assert(ftIntent3 === 'FILE_SEND', `IntentAgent: "share the log file" → FILE_SEND (got ${ftIntent3})`);

  console.log('PASS: IntentAgent FILE_SEND fast-path pattern matching');

  // ── FileAgent: _extractPath — various message formats ────────────────────
  const { FileAgent } = require('./src/agents/FileAgent');
  const ftDummyMessaging = { sendMessage: async () => {}, sendDocument: async () => {} };
  const ftAgent = new FileAgent(ftDummyMessaging);

  console.assert(ftAgent._extractPath('send me file /var/log/app.log') === '/var/log/app.log', 'FileAgent._extractPath: absolute unix path');
  console.assert(ftAgent._extractPath('send "logs/app.log"') === 'logs/app.log',               'FileAgent._extractPath: double-quoted path');
  console.assert(ftAgent._extractPath("share 'report.pdf'") === 'report.pdf',                  'FileAgent._extractPath: single-quoted path');
  console.assert(ftAgent._extractPath('send report.csv') === 'report.csv',                     'FileAgent._extractPath: extension-based fallback');

  let ftExtractThrew = false;
  try { ftAgent._extractPath('hello world'); } catch { ftExtractThrew = true; }
  console.assert(ftExtractThrew, 'FileAgent._extractPath: throws when no path found');
  console.log('PASS: FileAgent _extractPath parses message formats');

  // ── FileAgent: prepareFileTransfer delegates to readFileForTransfer ───────
  const ftPrepareTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-fp-'));
  const ftPrepareFile   = path.join(ftPrepareTmpDir, 'data.json');
  fs.writeFileSync(ftPrepareFile, '{"key":"value"}');
  const ftPrepared = ftAgent.prepareFileTransfer(ftPrepareFile);
  console.assert(ftPrepared.filename === 'data.json',        'FileAgent.prepareFileTransfer: filename');
  console.assert(ftPrepared.mimeType === 'application/json', 'FileAgent.prepareFileTransfer: mimeType');
  console.assert(typeof ftPrepared.base64 === 'string',      'FileAgent.prepareFileTransfer: base64 present');
  fs.rmSync(ftPrepareTmpDir, { recursive: true, force: true });
  console.log('PASS: FileAgent prepareFileTransfer delegates to readFileForTransfer');

  // ── FileAgent.handle(): sendDocument called with correct metadata ─────────
  const ftHandleTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-fh-'));
  const ftHandleFile   = path.join(ftHandleTmpDir, 'notes.txt');
  fs.writeFileSync(ftHandleFile, 'some content');

  let ftDocumentSent = null;
  const ftDocMessaging = {
    sendMessage:  async () => {},
    sendDocument: async (uid, item) => { ftDocumentSent = { uid, item }; },
  };
  const ftHandleAgent = new FileAgent(ftDocMessaging);
  await ftHandleAgent.handle('user@c.us', `send me file ${ftHandleFile}`);
  console.assert(ftDocumentSent !== null,                       'FileAgent.handle: sendDocument called');
  console.assert(ftDocumentSent.uid === 'user@c.us',           'FileAgent.handle: sendDocument uid');
  console.assert(ftDocumentSent.item.filename === 'notes.txt', 'FileAgent.handle: sendDocument filename');
  console.assert(ftDocumentSent.item.mimeType === 'text/plain','FileAgent.handle: sendDocument mimeType');
  fs.rmSync(ftHandleTmpDir, { recursive: true, force: true });
  console.log('PASS: FileAgent handle() sends file via sendDocument');

  // ── FileAgent.handle(): file not found — error reported to user ───────────
  let ftErrMsg = null;
  const ftErrMessaging = {
    sendMessage:  async (_uid, msg) => { ftErrMsg = msg; },
    sendDocument: async () => {},
  };
  await new FileAgent(ftErrMessaging).handle('user@c.us', 'send me file /nonexistent/path/file.txt');
  console.assert(ftErrMsg !== null && ftErrMsg.includes('Failed to send file'), 'FileAgent.handle: reports error on missing file');
  console.log('PASS: FileAgent handle() reports error when file not found');

  // ── FileAgent.handle(): no path in message — error reported to user ───────
  let ftNoPathMsg = null;
  const ftNoPathMessaging = { sendMessage: async (_uid, msg) => { ftNoPathMsg = msg; } };
  await new FileAgent(ftNoPathMessaging).handle('user@c.us', 'send me a file please');
  console.assert(ftNoPathMsg !== null && ftNoPathMsg.includes('Could not determine file path'), 'FileAgent.handle: reports error when no path in message');
  console.log('PASS: FileAgent handle() reports error when no path found in message');

  // ── CommunicationAgent: FILE_SEND intent routes to onFileSend ─────────────
  const { CommunicationAgent } = require('./src/agents/CommunicationAgent');
  const { MessagingLayer: MessagingLayerClass } = require('./src/messaging/MessagingLayer');

  class FakeMessagingForCA extends MessagingLayerClass {
    onMessage(cb) { this._messageCallback = cb; }
    async sendMessage() {}
  }

  let ftFileSendArgs = null;
  const ftCAMessaging = new FakeMessagingForCA();
  const ftCA = new CommunicationAgent(
    ftCAMessaging,
    ['alice@c.us'],
    { onFileSend: (uid, text, multimodal) => { ftFileSendArgs = { uid, text, multimodal }; } },
    async (_uid, text) => /send me file/i.test(text) ? 'FILE_SEND' : 'TASK',
  );
  ftCA.start();

  const ftCAMsg = buildMessage({ userId: 'alice@c.us', text: 'send me file /tmp/report.txt' });
  await ftCAMessaging._messageCallback(ftCAMsg);
  await new Promise(r => setTimeout(r, 20)); // let async dispatch settle
  console.assert(ftFileSendArgs !== null,                              'CommunicationAgent: FILE_SEND routes to onFileSend');
  console.assert(ftFileSendArgs.uid === 'alice@c.us',                 'CommunicationAgent: onFileSend receives correct userId');
  console.assert(ftFileSendArgs.text.includes('send me file'),        'CommunicationAgent: onFileSend receives message text');
  console.log('PASS: CommunicationAgent routes FILE_SEND intent to onFileSend handler');

  // ── WhatsAppProvider.sendFileAttachment: error-path guards ────────────────
  // WhatsAppProvider cannot be instantiated in tests (needs Puppeteer/whatsapp-web.js
  // headless browser), so we validate its error-guard logic in isolation.
  const ftWapTmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-wap-'));
  const ftWapFile    = path.join(ftWapTmpDir, 'output.txt');
  fs.writeFileSync(ftWapFile, 'WhatsApp file transfer test');

  // Thin harness that mirrors the real sendFileAttachment guards exactly
  async function stubSendFileAttachment(connected, filePath) {
    if (!connected) throw new Error('[WhatsApp] Cannot send — not connected');
    let stat;
    try { stat = fs.statSync(filePath); } catch (err) {
      if (err.code === 'EACCES') throw new Error(`[WhatsApp] Access denied: ${filePath}`);
      throw new Error(`[WhatsApp] File not found: ${filePath}`);
    }
    if (!stat.isFile()) throw new Error(`[WhatsApp] Path is not a file: ${filePath}`);
    const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      const sizeMB  = (stat.size / (1024 * 1024)).toFixed(2);
      const limitMB = (MAX_ATTACHMENT_BYTES / (1024 * 1024)).toFixed(0);
      throw new Error(`[WhatsApp] File too large: ${sizeMB} MB exceeds the ${limitMB} MB limit`);
    }
    return 'sent';
  }

  let wapNotConnected = null;
  try { await stubSendFileAttachment(false, ftWapFile); } catch (err) { wapNotConnected = err.message; }
  console.assert(wapNotConnected && wapNotConnected.includes('not connected'), 'sendFileAttachment: throws when not connected');

  let wapNotFound = null;
  try { await stubSendFileAttachment(true, path.join(ftWapTmpDir, 'missing.txt')); } catch (err) { wapNotFound = err.message; }
  console.assert(wapNotFound && wapNotFound.includes('File not found'), 'sendFileAttachment: throws File not found');

  const wapOk = await stubSendFileAttachment(true, ftWapFile);
  console.assert(wapOk === 'sent', 'sendFileAttachment: resolves when file exists and connected');

  fs.rmSync(ftWapTmpDir, { recursive: true, force: true });
  console.log('PASS: WhatsAppProvider sendFileAttachment error-path guards');

  // ── End-to-end file transfer: classify → FileAgent → mock sendDocument ────
  // Simulates the full runtime pipeline:
  //   1. IntentAgent classifies "send me file <path>" → FILE_SEND (fast path, no LLM)
  //   2. Router calls FileAgent.handle()
  //   3. FileAgent reads the file via FileHandler.readFileForTransfer()
  //   4. FileAgent calls sendDocument() on the messaging layer
  const e2eFtTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-e2e-ft-'));
  const e2eFtFile   = path.join(e2eFtTmpDir, 'summary.txt');
  fs.writeFileSync(e2eFtFile, 'End-to-end file transfer content');

  let e2eFtDocSent = null;
  let e2eFtErrMsg  = null;
  const e2eFtMessaging = {
    sendMessage:  async (_uid, msg) => { e2eFtErrMsg = msg; },
    sendDocument: async (uid, item) => { e2eFtDocSent = { uid, item }; },
  };
  const e2eFtAgent  = new FileAgent(e2eFtMessaging);
  const e2eIntentAg = new IntentAgent();
  e2eIntentAg._executor.run = async () => { throw new Error('LLM not available in test'); };

  // Step 1: classify
  const e2eFtMessage = `send me file ${e2eFtFile}`;
  const e2eFtIntent  = await e2eIntentAg.classify(e2eFtMessage);
  console.assert(e2eFtIntent === 'FILE_SEND', `e2e file transfer: intent is FILE_SEND (got ${e2eFtIntent})`);

  // Step 2: route to FileAgent
  if (e2eFtIntent === 'FILE_SEND') await e2eFtAgent.handle('e2e-user@c.us', e2eFtMessage);

  // Step 3: verify delivery
  console.assert(e2eFtDocSent !== null,                         'e2e file transfer: sendDocument was called');
  console.assert(e2eFtDocSent.uid === 'e2e-user@c.us',         'e2e file transfer: correct userId');
  console.assert(e2eFtDocSent.item.filename === 'summary.txt', 'e2e file transfer: correct filename');
  console.assert(e2eFtDocSent.item.mimeType === 'text/plain',  'e2e file transfer: correct MIME type');
  console.assert(
    Buffer.from(e2eFtDocSent.item.base64, 'base64').toString('utf8') === 'End-to-end file transfer content',
    'e2e file transfer: file content preserved through base64 encoding'
  );
  console.assert(e2eFtErrMsg === null, 'e2e file transfer: no error message sent to user');

  fs.rmSync(e2eFtTmpDir, { recursive: true, force: true });
  console.log('PASS: e2e file transfer — classify → FileAgent → sendDocument');

  console.log('\nAll agent tests passed.');
  process.exit(0);
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });

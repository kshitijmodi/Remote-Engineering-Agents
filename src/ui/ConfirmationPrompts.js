/**
 * ConfirmationPrompts — pre-built button prompt helpers for common REA interaction patterns.
 *
 * Each helper returns a { type, payload } object compatible with
 * WhatsAppProvider.sendQuickReply() or WhatsAppProvider.sendListMessage().
 *
 * Button ID conventions:
 *   confirm_yes / confirm_no          — simple yes/no
 *   ccm_confirm / ccm_cancel / ccm_modify — confirm / cancel / modify workflow
 *   choice_<index>                     — generic numbered choice
 */

const { buildQuickReply, buildListMessage } = require('./WhatsAppButtons');

/**
 * Yes / No quick reply.
 *
 * @param {string} question       - The question to ask the user.
 * @param {object} [opts]
 * @param {string} [opts.header]  - Optional header text.
 * @param {string} [opts.footer]  - Optional footer text.
 * @param {string} [opts.yesLabel='Yes'] - Label for the affirmative button.
 * @param {string} [opts.noLabel='No']   - Label for the negative button.
 * @returns {{ type: 'quick_reply', payload: object }}
 */
function yesNo(question, opts = {}) {
  const { header, footer, yesLabel = 'Yes', noLabel = 'No' } = opts;
  return buildQuickReply(
    question,
    [
      { id: 'confirm_yes', title: yesLabel },
      { id: 'confirm_no',  title: noLabel  },
    ],
    { header, footer }
  );
}

/**
 * Confirm / Cancel / Modify quick reply — the standard three-option workflow
 * used when presenting a draft action to the user before execution.
 *
 * @param {string} bodyText       - Summary of the pending action.
 * @param {object} [opts]
 * @param {string} [opts.header]          - Optional header text.
 * @param {string} [opts.footer]          - Optional footer text.
 * @param {string} [opts.confirmLabel='✅ Confirm'] - Label for the confirm button.
 * @param {string} [opts.cancelLabel='❌ Cancel']   - Label for the cancel button.
 * @param {string} [opts.modifyLabel='✏️ Modify']   - Label for the modify button.
 * @returns {{ type: 'quick_reply', payload: object }}
 */
function confirmCancelModify(bodyText, opts = {}) {
  const {
    header,
    footer,
    confirmLabel = '✅ Confirm',
    cancelLabel  = '❌ Cancel',
    modifyLabel  = '✏️ Modify',
  } = opts;
  return buildQuickReply(
    bodyText,
    [
      { id: 'ccm_confirm', title: confirmLabel },
      { id: 'ccm_cancel',  title: cancelLabel  },
      { id: 'ccm_modify',  title: modifyLabel  },
    ],
    { header, footer }
  );
}

/**
 * Confirm / Cancel quick reply — two-option variant without modify.
 *
 * @param {string} bodyText       - Summary of the pending action.
 * @param {object} [opts]
 * @param {string} [opts.header]          - Optional header text.
 * @param {string} [opts.footer]          - Optional footer text.
 * @param {string} [opts.confirmLabel='✅ Confirm'] - Label for the confirm button.
 * @param {string} [opts.cancelLabel='❌ Cancel']   - Label for the cancel button.
 * @returns {{ type: 'quick_reply', payload: object }}
 */
function confirmCancel(bodyText, opts = {}) {
  const {
    header,
    footer,
    confirmLabel = '✅ Confirm',
    cancelLabel  = '❌ Cancel',
  } = opts;
  return buildQuickReply(
    bodyText,
    [
      { id: 'ccm_confirm', title: confirmLabel },
      { id: 'ccm_cancel',  title: cancelLabel  },
    ],
    { header, footer }
  );
}

/**
 * Generic choice list — presents an arbitrary set of options as a list message.
 * Useful when there are more than 3 options (exceeding quick-reply limits).
 *
 * @param {string} question       - The question / instruction shown in the body.
 * @param {string[]} choices      - Array of choice labels (max 10).
 * @param {object} [opts]
 * @param {string} [opts.header]       - Optional header text.
 * @param {string} [opts.footer]       - Optional footer text.
 * @param {string} [opts.buttonLabel='Choose an option'] - Label on the list picker button.
 * @param {string} [opts.sectionTitle='Options']         - Title for the single section.
 * @returns {{ type: 'list', payload: object }}
 */
function choiceList(question, choices, opts = {}) {
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('choiceList: choices must be a non-empty array');
  }

  const {
    header,
    footer,
    buttonLabel  = 'Choose an option',
    sectionTitle = 'Options',
  } = opts;

  const rows = choices.map((label, i) => ({
    id:    `choice_${i}`,
    title: String(label),
  }));

  return buildListMessage(
    question,
    buttonLabel,
    [{ title: sectionTitle, rows }],
    { header, footer }
  );
}

/**
 * Retry / Cancel quick reply — shown after a failure to let the user decide
 * whether to retry the last operation or abandon it.
 *
 * @param {string} bodyText       - Description of what failed.
 * @param {object} [opts]
 * @param {string} [opts.header]        - Optional header text.
 * @param {string} [opts.footer]        - Optional footer text.
 * @param {string} [opts.retryLabel='🔄 Retry']   - Label for the retry button.
 * @param {string} [opts.cancelLabel='❌ Cancel']  - Label for the cancel button.
 * @returns {{ type: 'quick_reply', payload: object }}
 */
function retryCancel(bodyText, opts = {}) {
  const {
    header,
    footer,
    retryLabel  = '🔄 Retry',
    cancelLabel = '❌ Cancel',
  } = opts;
  return buildQuickReply(
    bodyText,
    [
      { id: 'retry_retry',  title: retryLabel  },
      { id: 'retry_cancel', title: cancelLabel },
    ],
    { header, footer }
  );
}

module.exports = {
  yesNo,
  confirmCancelModify,
  confirmCancel,
  choiceList,
  retryCancel,
};

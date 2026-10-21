// In-app replacement for the browser's confirm() pop-up, styled like the rest
// of the app. Built on <dialog>, so focus stays inside it and Esc cancels.
//
//   const ok = await window.appConfirm({
//     title: 'Delete this trip?',
//     message: 'Its 4 items will be removed too.',
//     confirmText: 'Delete', cancelText: 'Keep', danger: true,
//   });
//
// Resolves true only when the confirm button is pressed. appChoose() takes an
// extra altText button and resolves 'confirm', 'alt', or 'cancel' (Esc, the
// backdrop, or the cancel button). appPrompt() adds a text box and resolves
// what was typed (trimmed), or null if cancelled. Text is set with
// textContent, so names typed into the app can never become markup here.
(() => {
  'use strict';

  let dialog = null;

  function build() {
    dialog = document.createElement('dialog');
    dialog.className = 'app-dialog';
    dialog.setAttribute('aria-labelledby', 'app-dialog-title');
    dialog.setAttribute('aria-describedby', 'app-dialog-message');
    dialog.innerHTML = `
      <div class="app-dialog-body">
        <h2 class="app-dialog-title" id="app-dialog-title"></h2>
        <p class="app-dialog-message" id="app-dialog-message"></p>
        <input type="text" class="app-dialog-input" autocomplete="off" hidden>
        <div class="app-dialog-actions">
          <button type="button" data-choice="cancel" class="app-dialog-cancel"></button>
          <button type="button" data-choice="alt" class="app-dialog-alt"></button>
          <button type="button" data-choice="confirm" class="app-dialog-confirm"></button>
        </div>
      </div>
    `;
    // Plain buttons rather than <form method="dialog">: the site's
    // Content-Security-Policy (form-action 'none') blocks form submissions.
    dialog.querySelectorAll('[data-choice]').forEach((btn) => {
      btn.addEventListener('click', () => dialog.close(btn.dataset.choice));
    });
    // Tapping the dimmed backdrop (outside the box) counts as cancel.
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close('cancel');
    });
    dialog.querySelector('.app-dialog-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); dialog.close('confirm'); }
    });
    document.body.appendChild(dialog);
  }

  let queue = Promise.resolve();

  function show({ title, message = '', confirmText = 'OK', cancelText = 'Cancel', altText = '', danger = false, input = null }) {
    if (!dialog) build();
    dialog.querySelector('.app-dialog-title').textContent = title;
    const msg = dialog.querySelector('.app-dialog-message');
    msg.textContent = message;
    msg.hidden = !message;
    dialog.querySelector('.app-dialog-cancel').textContent = cancelText;
    const altBtn = dialog.querySelector('.app-dialog-alt');
    altBtn.textContent = altText;
    altBtn.hidden = !altText;
    const confirmBtn = dialog.querySelector('.app-dialog-confirm');
    confirmBtn.textContent = confirmText;
    confirmBtn.classList.toggle('danger', danger);
    const field = dialog.querySelector('.app-dialog-input');
    field.hidden = !input;
    field.value = input ? input.value || '' : '';
    field.placeholder = input ? input.placeholder || '' : '';
    field.maxLength = input && input.maxLength ? input.maxLength : 200;
    field.setAttribute('aria-label', input ? input.label || title : '');
    dialog.returnValue = 'cancel';
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue || 'cancel'), { once: true });
      dialog.showModal();
      // Destructive choices start on the safe button.
      if (input) { field.focus(); field.select(); } else (danger ? dialog.querySelector('.app-dialog-cancel') : confirmBtn).focus();
    });
  }

  // One dialog at a time — a second request waits for the first to close.
  window.appChoose = (options) => {
    const next = queue.then(() => show(options));
    queue = next.catch(() => {});
    return next;
  };
  window.appConfirm = async (options) => (await window.appChoose(options)) === 'confirm';
  window.appPrompt = async (options) => {
    const choice = await window.appChoose({ input: {}, ...options });
    return choice === 'confirm' ? dialog.querySelector('.app-dialog-input').value.trim() : null;
  };
})();

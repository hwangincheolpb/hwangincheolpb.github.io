/* =========================================================
   intake.js — "사진 넣으면 차트로" 드롭존
   - #intake-root 없으면 조용히 no-op (다른 에이전트가 index.html 작업 중)
   - 클릭 / 드래그&드롭 / 붙여넣기(paste)로 이미지 수신
   - POST http://localhost:8772/api/intake → 5초 간격 상태 폴링
   - 관리 서버(tool/run.sh)가 꺼져 있으면 안내만 하고 죽지 않음
   - 의존성 없음(vanilla), 색상은 site css 변수 재사용(다크/라이트 자동)
   ========================================================= */
(function () {
  'use strict';

  var API = 'http://localhost:8772/api';
  var POLL_MS = 5000;

  var root = document.getElementById('intake-root');
  if (!root) return; // index.html에 아직 없음 → no-op

  // 로컬 환경 전용: GitHub Pages 등 웹 배포에서는 관리 서버(8772)가 없으므로 숨김
  var LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', ''];
  if (LOCAL_HOSTS.indexOf(location.hostname) === -1) return;

  // ── 스타일 (css 변수만 참조 → 테마 자동 대응) ──────────────
  var style = document.createElement('style');
  style.textContent = [
    '#intake-root{display:inline-block}',
    '.intake-btn{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;',
    ' font:inherit;font-size:12px;cursor:pointer;border-radius:6px;',
    ' background:var(--surface,#fff);color:var(--text-secondary,#57534e);',
    ' border:1px solid var(--border,#e5e4e2);transition:border-color .15s}',
    '.intake-btn:hover{border-color:var(--accent,#1d4ed8);color:var(--accent,#1d4ed8)}',
    '.intake-btn.dragover{border-color:var(--accent,#1d4ed8);background:var(--accent-muted,#dbeafe)}',
    '.intake-btn.busy{opacity:.7;cursor:default}',
    '.intake-toast{position:fixed;right:16px;bottom:16px;z-index:9999;max-width:340px;',
    ' padding:10px 14px;border-radius:8px;font-size:13px;line-height:1.5;',
    ' background:var(--surface,#fff);color:var(--text-primary,#1c1917);',
    ' border:1px solid var(--border,#e5e4e2);box-shadow:var(--shadow-md,0 4px 6px rgba(0,0,0,.1))}',
    '.intake-toast a{color:var(--accent,#1d4ed8);cursor:pointer;text-decoration:underline}',
    '.intake-toast .intake-x{float:right;margin-left:10px;cursor:pointer;color:var(--text-muted,#a8a29e)}'
  ].join('');
  document.head.appendChild(style);

  // ── UI ──────────────────────────────────────────────────────
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'intake-btn';
  btn.textContent = '📷 차트 추가'; // 📷 차트 추가
  root.appendChild(btn);

  var fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.style.display = 'none';
  root.appendChild(fileInput);

  var toastEl = null;
  function toast(html, sticky) {
    if (toastEl) toastEl.remove();
    toastEl = document.createElement('div');
    toastEl.className = 'intake-toast';
    toastEl.innerHTML = '<span class="intake-x" title="닫기">✕</span>' + html;
    toastEl.querySelector('.intake-x').addEventListener('click', function () {
      toastEl.remove();
      toastEl = null;
    });
    document.body.appendChild(toastEl);
    if (!sticky) {
      setTimeout(function () {
        if (toastEl) { toastEl.remove(); toastEl = null; }
      }, 6000);
    }
  }

  var busy = false;
  function setBusy(b, label) {
    busy = b;
    btn.classList.toggle('busy', b);
    btn.textContent = b ? (label || '⏳ 처리 중…') : '📷 차트 추가';
  }

  // ── 업로드 + 폴링 ───────────────────────────────────────────
  function upload(file) {
    if (busy) { toast('이미 처리 중인 이미지가 있어요. 잠시만요.'); return; }
    if (!file || file.type.indexOf('image/') !== 0) {
      toast('이미지 파일만 넣을 수 있어요.');
      return;
    }
    setBusy(true, '⏫ 업로드 중…');
    var fd = new FormData();
    fd.append('image', file, file.name || 'pasted.png');

    fetch(API + '/intake', { method: 'POST', body: fd })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) {
          throw new Error((j && j.detail) || ('HTTP ' + r.status));
        });
        return r.json();
      })
      .then(function (j) {
        setBusy(true, '🤖 판독 중… (수 분 소요)');
        toast('업로드 완료 — AI가 차트를 판독하고 있어요. 끝나면 알려드릴게요.');
        poll(j.job_id);
      })
      .catch(function (e) {
        setBusy(false);
        if (e instanceof TypeError) {
          // fetch 자체 실패 = 서버 안 떠 있음
          toast('관리 서버 꺼짐: <code>tool/run.sh</code> 실행 필요 (포트 8772)', true);
        } else {
          toast('업로드 실패: ' + e.message, true);
        }
      });
  }

  function poll(jobId) {
    var timer = setInterval(function () {
      fetch(API + '/intake/' + jobId)
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.status === 'processing') return; // 계속 대기
          clearInterval(timer);
          setBusy(false);
          if (j.status === 'done') {
            var n = (j.new_charts || []).length;
            toast(
              '✅ 인박스에 추가됨' + (n ? ' (' + j.new_charts.join(', ') + ')' : '') +
              ' — <a id="intake-reload">새로고침</a>', true);
            var a = toastEl && toastEl.querySelector('#intake-reload');
            if (a) a.addEventListener('click', function () { location.reload(); });
          } else {
            toast('⚠️ 처리 실패(' + j.status + '). 로그: <code>' + (j.log || '') + '</code>', true);
          }
        })
        .catch(function () {
          clearInterval(timer);
          setBusy(false);
          toast('상태 조회 실패 — 관리 서버(8772)가 꺼졌을 수 있어요.', true);
        });
    }, POLL_MS);
  }

  // ── 입력 경로: 클릭 / 드래그&드롭 / 붙여넣기 ────────────────
  btn.addEventListener('click', function () { if (!busy) fileInput.click(); });
  fileInput.addEventListener('change', function () {
    if (fileInput.files && fileInput.files[0]) upload(fileInput.files[0]);
    fileInput.value = '';
  });

  ['dragover', 'dragenter'].forEach(function (ev) {
    btn.addEventListener(ev, function (e) {
      e.preventDefault();
      btn.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    btn.addEventListener(ev, function (e) {
      e.preventDefault();
      btn.classList.remove('dragover');
    });
  });
  btn.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) upload(f);
  });

  document.addEventListener('paste', function (e) {
    if (!e.clipboardData) return;
    var items = e.clipboardData.items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image/') === 0) {
        var f = items[i].getAsFile();
        if (f) { upload(f); e.preventDefault(); }
        return;
      }
    }
  });
})();

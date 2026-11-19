(() => {
  'use strict';

  const config = window.BANK_CONFIG;
  const selectors = {
    deposit: '0xd0e30db0',
    withdraw: '0x2e1a7d4d',
    checkBlance: '0x2a7cc41f',
  };
  const weiPerEth = 10n ** 18n;
  const maxUint256 = (1n << 256n) - 1n;
  const addressPattern = /^0x[0-9a-fA-F]{40}$/;
  const hashPattern = /^0x[0-9a-f]{64}$/i;
  const defaultAddress = isAddress(config.contractAddress) ? config.contractAddress : '';
  const storageKey = 'bank-dapp:contract:' + location.pathname + ':' + config.chainId + ':' + defaultAddress;
  const infuraStorageKey = 'bank-dapp-infura:api-key:' + location.pathname;
  let rpcId = 0;
  const state = {
    rpcKey: '',
    rpcChecking: false,
    provider: null,
    account: null,
    chainId: null,
    address: loadAddress(),
    contract: 'unverified',
    balance: null,
    reading: false,
    connecting: false,
    sending: false,
    scope: 0,
    walletRequest: 0,
    transactions: [],
    receiptTimer: null,
    polling: false,
  };

  const $ = (id) => document.getElementById(id);
  const elements = {
    connect: $('connect'),
    refresh: $('refresh'),
    address: $('address'),
    badge: $('contract-badge'),
    detail: $('contract-detail'),
    feedback: $('feedback'),
    balance: $('balance'),
    balanceCaption: $('balance-caption'),
    transactions: $('transactions'),
    emptyHistory: $('empty-history'),
    infuraKey: $('infura-key'),
    infuraStatus: $('infura-status'),
    infuraSubmit: $('infura-submit'),
    infuraClear: $('infura-clear'),
  };
  const actions = {
    deposit: { name: 'ฝากเงิน', input: $('deposit-amount'), button: $('deposit-button') },
    withdraw: { name: 'ถอนเงิน', input: $('withdraw-amount'), button: $('withdraw-button') },
  };

  function isAddress(value) {
    return typeof value === 'string' && addressPattern.test(value) && !/^0x0{40}$/i.test(value);
  }

  function loadAddress() {
    try {
      const saved = localStorage.getItem(storageKey);
      if (isAddress(saved)) return saved;
    } catch {
      // The current tab can still use a contract when browser storage is blocked.
    }
    return defaultAddress;
  }

  function sameAddress(first, second) {
    return first?.toLowerCase() === second?.toLowerCase();
  }

  function brief(value) {
    return value.slice(0, 6) + '…' + value.slice(-4);
  }

  function formatEth(wei) {
    const whole = String(wei / weiPerEth);
    const fraction = String(wei % weiPerEth).padStart(18, '0').replace(/0+$/, '');
    return fraction ? whole + '.' + fraction : whole;
  }

  function parseEth(input) {
    const amount = input.trim();
    if (!/^(?:\d+(?:\.\d{0,18})?|\.\d{1,18})$/.test(amount)) {
      throw new Error('กรอกจำนวน ETH เป็นตัวเลขที่มีทศนิยมได้ไม่เกิน 18 ตำแหน่ง');
    }

    const [whole, fraction = ''] = amount.split('.');
    const wei = BigInt(whole || '0') * weiPerEth + BigInt(fraction.padEnd(18, '0'));
    if (wei <= 0n || wei > maxUint256) throw new Error('จำนวน ETH ต้องมากกว่า 0 และอยู่ในช่วงที่รองรับ');
    return wei;
  }

  function feedback(message, tone = 'normal') {
    elements.feedback.dataset.tone = tone;
    elements.feedback.textContent = message;
    elements.feedback.hidden = !message;
  }

  function errorMessage(error) {
    switch (error?.code) {
      case 4001: return 'คุณยกเลิกคำขอใน MetaMask';
      case 4100: return 'MetaMask ยังไม่ได้อนุญาตให้เว็บเข้าถึงบัญชีนี้';
      case 4900: return 'MetaMask หลุดจากเครือข่าย กรุณาเชื่อมต่ออีกครั้ง';
      case 4902: return 'MetaMask ยังไม่รู้จักเครือข่าย ' + config.networkName;
      case -32002: return 'มีคำขอค้างอยู่ กรุณาเปิด MetaMask เพื่อตรวจสอบ';
      default: {
        const message = error?.shortMessage || error?.message || 'เกิดข้อผิดพลาดจาก MetaMask';
        return state.rpcKey ? String(message).replaceAll(state.rpcKey, '••••') : message;
      }
    }
  }

  function getContractDisplay() {
    if (!state.address) return ['empty', 'ยังไม่ได้ตั้งค่า', 'วาง Contract Address จาก Remix แล้วกดบันทึก'];
    if (!state.account) return ['unverified', 'รอเชื่อมต่อ', 'เชื่อมต่อ MetaMask เพื่ออ่านยอดจากสัญญา'];
    if (state.chainId !== config.chainId) {
      return ['wrong-network', 'เครือข่ายไม่ตรง', 'สลับ MetaMask ไปที่ ' + config.networkName + ' เพื่อใช้สัญญานี้'];
    }
    if (!state.rpcKey) return ['unverified', 'รอ Infura', 'เชื่อมต่อ Infura เพื่ออ่านสัญญาบน Hoodi'];
    if (state.contract === 'invalid') {
      return ['invalid', 'ตรวจสอบไม่ผ่าน', 'ตรวจที่อยู่สัญญาและเครือข่าย แล้วกดบันทึกอีกครั้ง'];
    }
    if (state.contract === 'verified') {
      return ['verified', 'เชื่อมต่อแล้ว', 'สัญญาตอบกลับจากเครือข่าย ' + config.networkName];
    }
    return ['unverified', 'กำลังตรวจสอบ', 'กำลังตรวจว่าสามารถอ่านยอดเงินจากที่อยู่สัญญานี้ได้'];
  }

  function hasPendingTransaction() {
    return state.transactions.some((transaction) =>
      transaction.status === 'pending' && transaction.chainId === state.chainId &&
      sameAddress(transaction.from, state.account) && sameAddress(transaction.to, state.address)
    );
  }

  function render() {
    const onTarget = state.chainId === config.chainId;
    const connected = Boolean(state.account && onTarget);
    const canUseBank = connected && state.contract === 'verified';
    const locked = !canUseBank || state.sending || hasPendingTransaction();

    elements.connect.classList.toggle('is-connected', connected);
    elements.connect.disabled = state.connecting || connected;
    elements.connect.title = connected ? state.account : '';
    elements.connect.textContent = state.connecting ? 'กำลังเชื่อมต่อ…' :
      connected ? brief(state.account) : state.account ? 'สลับไป ' + config.networkName : 'เชื่อมต่อ MetaMask';

    elements.refresh.disabled = !canUseBank || state.reading;
    elements.refresh.lastChild.textContent = state.reading ? ' กำลังตรวจสอบ…' : ' ตรวจสอบยอดเงิน';
    for (const action of Object.values(actions)) {
      action.input.disabled = locked;
      action.button.disabled = locked;
    }

    elements.balance.textContent = state.balance === null ? '—' : formatEth(state.balance);
    if (state.balance !== null) {
      const unit = document.createElement('span');
      unit.textContent = ' ETH';
      elements.balance.append(unit);
    }
    elements.balanceCaption.textContent = state.account
      ? 'บัญชี ' + brief(state.account)
      : 'เชื่อมต่อ MetaMask เพื่อดูยอดเงิน';
    elements.balanceCaption.title = state.account || '';

    const [badgeState, badgeLabel, detail] = getContractDisplay();
    elements.badge.dataset.state = badgeState;
    elements.badge.textContent = badgeLabel;
    elements.detail.textContent = detail;

    const infuraReady = Boolean(state.rpcKey);
    elements.infuraKey.disabled = state.rpcChecking;
    elements.infuraSubmit.disabled = state.rpcChecking;
    elements.infuraClear.disabled = state.rpcChecking;
    elements.infuraClear.hidden = !infuraReady;
    elements.infuraStatus.dataset.state = infuraReady ? 'verified' : 'unverified';
    elements.infuraStatus.textContent = state.rpcChecking ? 'กำลังตรวจสอบ…' :
      infuraReady ? 'เชื่อมต่อแล้ว' : 'ยังไม่ได้ตั้งค่า';
  }

  function renderTransactions() {
    elements.emptyHistory.hidden = state.transactions.length > 0;
    elements.transactions.replaceChildren();
    const labels = { pending: 'รอยืนยัน', confirmed: 'สำเร็จ', reverted: 'ไม่สำเร็จ' };
    for (const transaction of state.transactions) {
      const row = document.createElement('li');
      const amount = document.createElement('strong');
      amount.className = 'transaction-amount';
      amount.textContent = actions[transaction.action].name + ' ' + formatEth(transaction.amount) + ' ETH';

      const status = document.createElement('span');
      status.className = 'status-badge';
      status.dataset.state = { confirmed: 'verified', reverted: 'invalid' }[transaction.status] || '';
      status.textContent = labels[transaction.status];

      const reference = document.createElement(config.explorer ? 'a' : 'span');
      reference.className = 'transaction-link';
      reference.textContent = brief(transaction.hash);
      reference.title = transaction.hash;
      if (config.explorer) {
        reference.href = config.explorer.replace(/\/$/, '') + '/tx/' + transaction.hash;
        reference.target = '_blank';
        reference.rel = 'noopener noreferrer';
        reference.setAttribute('aria-label', 'ดูธุรกรรม ' + transaction.hash);
      }
      row.append(amount, status, reference);
      elements.transactions.append(row);
    }
  }

  function request(method, params = []) {
    return state.provider.request({ method, params });
  }

  function loadInfuraKey() {
    try {
      return sessionStorage.getItem(infuraStorageKey) || '';
    } catch {
      return '';
    }
  }

  function rememberInfuraKey(key) {
    try {
      if (key) sessionStorage.setItem(infuraStorageKey, key);
      else sessionStorage.removeItem(infuraStorageKey);
    } catch {
      // The active tab still works if browser storage is unavailable.
    }
  }

  function infuraUrl(key) {
    return config.infuraBaseUrl + encodeURIComponent(key);
  }

  async function requestInfura(method, params = [], key = state.rpcKey) {
    if (!key) throw new Error('กรอก Infura API Key ก่อนใช้งาน');

    let response;
    try {
      response = await fetch(infuraUrl(key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
    } catch {
      throw new Error('ติดต่อ Infura ไม่สำเร็จ กรุณาตรวจเครือข่ายและสิทธิ์การใช้คีย์จากเบราว์เซอร์');
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error('Infura ปฏิเสธการเข้าถึง กรุณาตรวจ API Key และสิทธิ์สำหรับ Hoodi');
    }
    if (response.status === 429) throw new Error('Infura จำกัดจำนวนคำขอ กรุณาลองอีกครั้งภายหลัง');
    if (!response.ok) throw new Error('Infura ตอบกลับด้วยรหัส HTTP ' + response.status);

    const payload = await response.json().catch(() => null);
    if (!payload || payload.error || !Object.hasOwn(payload, 'result')) {
      throw new Error('Infura ไม่สามารถประมวลผลคำขอ ' + method);
    }
    return payload.result;
  }

  async function activateInfuraKey(key, restoring = false) {
    if (state.rpcChecking) return;
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
      if (restoring) rememberInfuraKey('');
      else feedback('กรอก API Key จาก Infura Dashboard', 'error');
      return;
    }

    state.rpcChecking = true;
    render();
    try {
      const chain = await requestInfura('eth_chainId', [], key);
      if (chain !== config.chainId) throw new Error('Infura ต้องตอบกลับจากเครือข่าย Hoodi');
      state.rpcKey = key;
      rememberInfuraKey(key);
      elements.infuraKey.value = '';
      if (!restoring) feedback('เชื่อมต่อ Infura บน Hoodi แล้ว');
      await verifyContract();
      scheduleReceipts();
    } catch (error) {
      if (restoring) rememberInfuraKey('');
      feedback(errorMessage(error), 'error');
    } finally {
      state.rpcChecking = false;
      render();
    }
  }

  function clearInfuraKey() {
    state.rpcKey = '';
    rememberInfuraKey('');
    elements.infuraKey.value = '';
    invalidateBank();
    feedback('ล้าง Infura API Key จากเซสชันของเบราว์เซอร์แล้ว');
  }

  function chooseProvider(provider) {
    if (state.provider || !provider?.request) return;
    state.provider = provider;
    provider.on?.('accountsChanged', handleWalletChange);
    provider.on?.('chainChanged', handleWalletChange);
    provider.on?.('connect', handleWalletChange);
    provider.on?.('disconnect', handleWalletChange);
    void syncWallet();
  }

  function legacyMetaMask() {
    const injected = window.ethereum;
    return injected?.providers?.find((provider) => provider.isMetaMask) ||
      (injected?.isMetaMask ? injected : null);
  }

  function handleWalletChange() {
    state.account = null;
    state.chainId = null;
    invalidateBank();
    void syncWallet();
  }

  async function syncWallet(reportError = false) {
    const version = ++state.walletRequest;
    try {
      const [accounts, chain] = await Promise.all([request('eth_accounts'), request('eth_chainId')]);
      if (version !== state.walletRequest) return;
      const account = isAddress(accounts?.[0]) ? accounts[0] : null;
      const chainId = typeof chain === 'string' ? chain.toLowerCase() : null;
      if (!sameAddress(account, state.account) || chainId !== state.chainId) {
        state.account = account;
        state.chainId = chainId;
        await verifyContract();
      }
      scheduleReceipts();
    } catch (error) {
      if (version !== state.walletRequest) return;
      state.account = null;
      state.chainId = null;
      invalidateBank();
      if (reportError) feedback(errorMessage(error), 'error');
    }
  }

  function invalidateBank() {
    state.scope++;
    state.contract = 'unverified';
    state.balance = null;
    state.reading = false;
    render();
  }

  async function switchToBankNetwork() {
    const switchParams = [{ chainId: config.chainId }];

    try {
      await request('wallet_switchEthereumChain', switchParams);
    } catch (error) {
      if (error?.code !== 4902) throw error;
      if (!state.rpcKey) throw new Error('เชื่อมต่อ Infura ก่อนเพิ่มเครือข่าย Hoodi ใน MetaMask');

      await request('wallet_addEthereumChain', [{
        chainId: config.chainId,
        chainName: config.networkName,
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: [infuraUrl(state.rpcKey)],
        blockExplorerUrls: [config.explorer],
      }]);

      const chain = await request('eth_chainId');
      if (chain.toLowerCase() !== config.chainId) {
        await request('wallet_switchEthereumChain', switchParams);
      }
    }
  }

  async function connect() {
    if (!state.provider) chooseProvider(legacyMetaMask());
    if (!state.provider) {
      feedback('ไม่พบ MetaMask กรุณาติดตั้งส่วนขยายแล้วเปิดหน้านี้ใหม่', 'error');
      return;
    }

    state.connecting = true;
    feedback('');
    render();
    try {
      await request('eth_requestAccounts');
      const chain = await request('eth_chainId');
      if (chain.toLowerCase() !== config.chainId) {
        await switchToBankNetwork();
      }
    } catch (error) {
      feedback(errorMessage(error), 'error');
    } finally {
      state.connecting = false;
      await syncWallet(true);
      render();
    }
  }

  function currentCall() {
    return { from: state.account, to: state.address, data: selectors.checkBlance };
  }

  async function readBalance(call) {
    const result = await requestInfura('eth_call', [call, 'latest']);
    if (!hashPattern.test(result)) {
      throw new Error('สัญญานี้ไม่ส่งยอดเงินตามรูปแบบของ checkBlance()');
    }
    return BigInt(result);
  }

  async function verifyContract() {
    invalidateBank();
    if (!state.rpcKey || !state.account || !state.address || state.chainId !== config.chainId) return;

    const version = state.scope;
    const call = currentCall();
    try {
      const code = await requestInfura('eth_getCode', [call.to, 'latest']);
      if (version !== state.scope) return;
      if (!/^0x(?:[0-9a-f]{2})+$/i.test(code)) {
        throw new Error('ไม่พบ Smart Contract ที่ที่อยู่นี้บน ' + config.networkName);
      }
      const balance = await readBalance(call);
      if (version !== state.scope) return;
      state.balance = balance;
      state.contract = 'verified';
    } catch (error) {
      if (version !== state.scope) return;
      state.contract = 'invalid';
      feedback('เชื่อมต่อสัญญาไม่สำเร็จ · ' + errorMessage(error), 'error');
    }
    render();
  }

  async function refreshBalance(announce = false) {
    if (state.contract !== 'verified' || state.reading) return;

    const version = state.scope;
    state.reading = true;
    render();
    try {
      const balance = await readBalance(currentCall());
      if (version !== state.scope) return;
      state.balance = balance;
      if (announce) feedback('ตรวจสอบยอดเงินแล้ว');
    } catch (error) {
      if (version === state.scope) feedback('อ่านยอดเงินไม่สำเร็จ · ' + errorMessage(error), 'error');
    } finally {
      if (version === state.scope) {
        state.reading = false;
        render();
      }
    }
  }

  function saveContract(event) {
    event.preventDefault();
    const address = elements.address.value.trim();
    if (!isAddress(address)) {
      feedback('กรอก Contract Address ที่ขึ้นต้นด้วย 0x ตามด้วยเลขฐานสิบหก 40 ตัว', 'error');
      elements.address.focus();
      return;
    }

    state.address = address;
    elements.address.value = address;
    try {
      localStorage.setItem(storageKey, address);
      feedback('บันทึกที่อยู่สัญญาในเบราว์เซอร์แล้ว');
    } catch {
      feedback('ตั้งค่าที่อยู่สัญญาสำหรับแท็บนี้แล้ว');
    }
    void verifyContract();
  }

  async function transact(actionName, event) {
    event.preventDefault();
    if (state.contract !== 'verified' || state.sending || hasPendingTransaction()) return;
    const action = actions[actionName];
    const input = action.input.value;
    const version = state.scope;
    const call = currentCall();
    const chainId = state.chainId;
    state.sending = true;
    render();

    try {
      const amount = parseEth(input);
      const { from, to } = call;
      let transaction;
      if (actionName === 'deposit') {
        transaction = { from, to, data: selectors.deposit, value: '0x' + amount.toString(16) };
      } else {
        const balance = await readBalance(call);
        if (version !== state.scope) return;
        state.balance = balance;
        if (amount > balance) throw new Error('ยอดเงินในสัญญาไม่พอสำหรับการถอน');
        transaction = { from, to, data: selectors.withdraw + amount.toString(16).padStart(64, '0') };
      }
      feedback('ตรวจสอบและยืนยันรายการใน MetaMask');
      const hash = await request('eth_sendTransaction', [transaction]);
      if (!hashPattern.test(hash)) throw new Error('MetaMask ไม่ได้ส่งรหัสธุรกรรมกลับมา');
      state.transactions.unshift({ action: actionName, amount, from, to, chainId, hash, status: 'pending' });
      renderTransactions();
      if (version === state.scope) {
        action.input.value = '';
        feedback('ส่งธุรกรรมแล้ว กำลังรอการยืนยันจากเครือข่าย');
      }
      scheduleReceipts(350);
    } catch (error) {
      if (version === state.scope) feedback(action.name + 'ไม่สำเร็จ · ' + errorMessage(error), 'error');
    } finally {
      state.sending = false;
      render();
    }
  }

  function pendingOnCurrentChain() {
    if (!state.rpcKey) return [];
    return state.transactions.filter((entry) => entry.status === 'pending' && entry.chainId === state.chainId);
  }

  function scheduleReceipts(delay = 4000) {
    if (state.polling || state.receiptTimer !== null || pendingOnCurrentChain().length === 0) return;
    state.receiptTimer = setTimeout(pollReceipts, delay);
  }

  async function pollReceipts() {
    state.receiptTimer = null;
    state.polling = true;
    try {
      let refresh = false;
      for (const transaction of pendingOnCurrentChain()) {
        if (transaction.chainId !== state.chainId) break;
        const key = state.rpcKey;
        if (!key) break;
        let receipt;
        try {
          receipt = await requestInfura('eth_getTransactionReceipt', [transaction.hash], key);
        } catch {
          continue;
        }
        if (key !== state.rpcKey || transaction.chainId !== state.chainId || !receipt) continue;
        if (!/^0x(?:0*0|0*1)$/i.test(receipt.status)) continue;

        transaction.status = BigInt(receipt.status) === 1n ? 'confirmed' : 'reverted';
        if (sameAddress(transaction.from, state.account) && sameAddress(transaction.to, state.address)) {
          const success = transaction.status === 'confirmed';
          feedback(actions[transaction.action].name + (success ? 'สำเร็จ' : 'ไม่สำเร็จบนเครือข่าย'), success ? 'normal' : 'error');
          refresh = true;
        }
        renderTransactions();
        render();
      }
      if (refresh) await refreshBalance();
    } finally {
      state.polling = false;
      scheduleReceipts();
    }
  }

  $('network-name').textContent = config.networkName;
  $('student-id').textContent = config.studentId || 'ยังไม่ระบุ';
  $('student-name').textContent = config.studentName || 'ยังไม่ระบุ';
  elements.address.value = state.address;
  $('contract-form').addEventListener('submit', saveContract);

  $('infura-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void activateInfuraKey(elements.infuraKey.value.trim());
  });
  elements.infuraClear.addEventListener('click', clearInfuraKey);
  elements.connect.addEventListener('click', connect);
  elements.refresh.addEventListener('click', () => void refreshBalance(true));
  for (const actionName of Object.keys(actions)) {
    $(actionName + '-form').addEventListener('submit', (event) => void transact(actionName, event));
  }

  window.addEventListener('eip6963:announceProvider', ({ detail }) => {
    if (detail?.info?.rdns === 'io.metamask') chooseProvider(detail.provider);
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  if (!state.provider) chooseProvider(legacyMetaMask());
  render();
  const savedInfuraKey = loadInfuraKey();
  if (savedInfuraKey) void activateInfuraKey(savedInfuraKey, true);
})();

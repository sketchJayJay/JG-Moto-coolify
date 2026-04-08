const App = {
  state: {
    token: localStorage.getItem('jg_token') || '',
    user: JSON.parse(localStorage.getItem('jg_user') || 'null'),
    dashboard: null,
    company: null,
    clients: [],
    motorcycles: [],
    products: [],
    budgets: [],
    orders: [],
    sales: [],
    receipts: [],
    finance: [],
    fiscal: [],
    fiscalCertificate: null,
    reports: null,
    pendingFiscalOrderId: null,
    editing: {
      clientId: null,
      motorcycleId: null,
      productId: null,
      budgetId: null,
      orderId: null,
      financeId: null,
    },
  },

  async init() {
    if (this.state.token) {
      try {
        await this.api('/auth/me');
        this.renderShell();
        await this.loadAll();
        return;
      } catch (_error) {
        this.logout();
      }
    }
    this.renderLogin();
  },

  get app() {
    return document.getElementById('app');
  },

  money(value) {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value || 0));
  },

  date(value) {
    if (!value) return '-';
    const safe = String(value).slice(0, 10);
    const [y, m, d] = safe.split('-');
    return d && m && y ? `${d}/${m}/${y}` : safe;
  },

  escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  },

  async api(path, options = {}) {
    const response = await fetch(`/api${path}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(this.state.token ? { Authorization: `Bearer ${this.state.token}` } : {}),
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const isJson = response.headers.get('content-type')?.includes('application/json');
    const data = isJson ? await response.json() : await response.text();
    if (!response.ok) {
      throw new Error(data?.message || 'Falha na requisição.');
    }
    return data;
  },

  toast(message, type = 'ok') {
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.textContent = message;
    document.body.appendChild(node);
    requestAnimationFrame(() => node.classList.add('show'));
    setTimeout(() => {
      node.classList.remove('show');
      setTimeout(() => node.remove(), 260);
    }, 2400);
  },

  renderLogin() {
    this.app.innerHTML = `
      <div class="login-shell">
        <div class="login-card">
          <div class="brand-lockup">
            <img src="logo.png" alt="JG Motos">
            <div>
              <h1>JG MOTOS V2</h1>
              <p>Web + API + PostgreSQL, pronto para Coolify.</p>
            </div>
          </div>
          <form id="loginForm" class="login-form">
            <div class="field"><label>E-mail</label><input name="email" type="email" value="admin@jgmotos.local" required></div>
            <div class="field"><label>Senha</label><input name="password" type="password" value="123456" required></div>
            <button class="primary-btn" type="submit">Entrar no sistema</button>
          </form>
          <div class="login-tip">
            <strong>Primeiro acesso:</strong> admin@jgmotos.local • 123456
          </div>
        </div>
      </div>
    `;

    document.getElementById('loginForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      try {
        const data = await this.api('/auth/login', {
          method: 'POST',
          body: {
            email: formData.get('email'),
            password: formData.get('password'),
          },
        });
        this.state.token = data.token;
        this.state.user = data.user;
        localStorage.setItem('jg_token', data.token);
        localStorage.setItem('jg_user', JSON.stringify(data.user));
        this.renderShell();
        await this.loadAll();
        this.toast('Login realizado com sucesso.');
      } catch (error) {
        this.toast(error.message, 'error');
      }
    });
  },

  renderShell() {
    this.app.innerHTML = `
      <div class="shell">
        <aside class="sidebar">
          <div class="brand-lockup side">
            <img src="logo.png" alt="JG Motos">
            <div>
              <h1>JG MOTOS</h1>
              <p>V2 para Coolify</p>
            </div>
          </div>
          <nav class="nav" id="nav">
            ${['dashboard','empresa','clientes','motos','estoque','orcamentos','os','vendas','recibos','financeiro','fiscal','backup'].map((item, index) => `
              <button class="nav-btn ${index === 0 ? 'active' : ''}" data-section="${item}">${({dashboard:'Dashboard',empresa:'Empresa',clientes:'Clientes',motos:'Motos',estoque:'Estoque',orcamentos:'Orçamentos',os:'Ordens de serviço',vendas:'Vendas',recibos:'Recibos',financeiro:'Financeiro',fiscal:'Fiscal',backup:'Backup & relatórios'})[item]}</button>
            `).join('')}
          </nav>
          <div class="sidebar-footer">
            <div class="user-badge">${this.escape(this.state.user?.name || 'Usuário')}</div>
            <button id="logoutBtn" class="ghost-btn fullw">Sair</button>
          </div>
        </aside>
        <main class="content">
          <header class="topbar">
            <div>
              <h2 id="screenTitle">Dashboard</h2>
              <p id="screenSubtitle">Controle total da oficina, do balcão e do caixa.</p>
            </div>
            <div class="top-tags">
              <span>Coolify</span>
              <span>PostgreSQL</span>
              <span>Celular + computador</span>
            </div>
          </header>
          <section id="view"></section>
        </main>
      </div>
    `;

    document.getElementById('logoutBtn').addEventListener('click', () => this.logout());
    document.getElementById('nav').addEventListener('click', (event) => {
      const button = event.target.closest('.nav-btn');
      if (!button) return;
      this.goToSection(button.dataset.section);
    });
    this.renderSection('dashboard');
  },

  setActiveSection(section) {
    document.querySelectorAll('.nav-btn').forEach((node) => {
      node.classList.toggle('active', node.dataset.section === section);
    });
  },

  goToSection(section) {
    this.setActiveSection(section);
    this.renderSection(section);
  },

  openFiscalForOrder(orderId) {
    this.state.pendingFiscalOrderId = orderId ? Number(orderId) : null;
    this.goToSection('fiscal');
  },

  async loadAll() {
    const [dashboard, company, clients, motorcycles, products, budgets, orders, sales, receipts, finance, fiscal, fiscalCertificate, reports] = await Promise.all([
      this.api('/dashboard'),
      this.api('/company'),
      this.api('/clients'),
      this.api('/motorcycles'),
      this.api('/products'),
      this.api('/budgets'),
      this.api('/service-orders'),
      this.api('/sales'),
      this.api('/receipts'),
      this.api('/finance'),
      this.api('/fiscal-documents'),
      this.api('/fiscal/certificate'),
      this.api('/reports/summary'),
    ]);

    Object.assign(this.state, { dashboard, company, clients, motorcycles, products, budgets, orders, sales, receipts, finance, fiscal, fiscalCertificate, reports });
    const active = document.querySelector('.nav-btn.active')?.dataset.section || 'dashboard';
    this.renderSection(active);
  },

  renderSection(section) {
    const titles = {
      dashboard: ['Dashboard', 'Pulso da oficina em tempo real.'],
      empresa: ['Empresa', 'Dados da JG MOTOS usados em documentos e recibos.'],
      clientes: ['Clientes', 'Cadastro completo e histórico do dono da moto.'],
      motos: ['Motos', 'Vínculo da moto com o cliente e situação técnica.'],
      estoque: ['Estoque', 'Peças, acessórios, custo, preço e alerta de falta.'],
      orcamentos: ['Orçamentos', 'Monte orçamento, aprove e converta em OS.'],
      os: ['Ordens de serviço', 'Diagnóstico, execução e status da oficina.'],
      vendas: ['Vendas', 'Balcão com baixa automática do estoque.'],
      recibos: ['Recibos', 'Comprovante rápido e organizado.'],
      financeiro: ['Financeiro', 'Entradas, saídas e caixa vivo.'],
      fiscal: ['Fiscal', 'Pré-integração para NF-e e NFS-e.'],
      backup: ['Backup & relatórios', 'Exportação, restauração e visão resumida.'],
    };

    const [title, subtitle] = titles[section] || titles.dashboard;
    document.getElementById('screenTitle').textContent = title;
    document.getElementById('screenSubtitle').textContent = subtitle;

    const view = document.getElementById('view');
    if (section === 'dashboard') view.innerHTML = this.dashboardTemplate();
    if (section === 'empresa') view.innerHTML = this.companyTemplate();
    if (section === 'clientes') view.innerHTML = this.clientsTemplate();
    if (section === 'motos') view.innerHTML = this.motorcyclesTemplate();
    if (section === 'estoque') view.innerHTML = this.productsTemplate();
    if (section === 'orcamentos') view.innerHTML = this.budgetsTemplate();
    if (section === 'os') view.innerHTML = this.ordersTemplate();
    if (section === 'vendas') view.innerHTML = this.salesTemplate();
    if (section === 'recibos') view.innerHTML = this.receiptsTemplate();
    if (section === 'financeiro') view.innerHTML = this.financeTemplate();
    if (section === 'fiscal') view.innerHTML = this.fiscalTemplate();
    if (section === 'backup') view.innerHTML = this.backupTemplate();
    this.bindSection(section);
  },

  dashboardTemplate() {
    const metrics = this.state.dashboard?.metrics || {};
    return `
      <div class="grid kpis">
        ${[
          ['Clientes', metrics.clients || 0],
          ['Motos', metrics.motorcycles || 0],
          ['Produtos', metrics.products || 0],
          ['Orçamentos abertos', metrics.openBudgets || 0],
          ['OS ativas', metrics.openOrders || 0],
          ['Vendas hoje', this.money(metrics.salesToday || 0)],
          ['Entradas hoje', this.money(metrics.cashInToday || 0)],
        ].map(([label, value]) => `<article class="card kpi"><span>${label}</span><strong>${value}</strong></article>`).join('')}
      </div>
      <div class="grid two">
        <article class="card">
          <div class="card-head"><h3>Estoque em alerta</h3></div>
          ${this.state.dashboard?.lowStock?.length ? `
            <div class="table-like">
              ${this.state.dashboard.lowStock.map((item) => `<div class="row"><span>${this.escape(item.name)}</span><strong>${item.quantity}</strong></div>`).join('')}
            </div>
          ` : `<p class="muted">Nenhum produto em alerta.</p>`}
        </article>
        <article class="card">
          <div class="card-head"><h3>Ordens recentes</h3></div>
          ${this.state.dashboard?.recentOrders?.length ? `
            <div class="stack">
              ${this.state.dashboard.recentOrders.map((item) => `<div class="soft-item"><b>${this.escape(item.number)}</b><span>${this.escape(item.client_name || 'Sem cliente')} • ${this.escape(item.status)}</span><small>${this.money(item.total)}</small></div>`).join('')}
            </div>
          ` : `<p class="muted">Sem ordens ainda.</p>`}
        </article>
      </div>
      <div class="grid two">
        <article class="card">
          <div class="card-head"><h3>Vendas recentes</h3></div>
          ${this.state.dashboard?.recentSales?.length ? `
            <div class="stack">
              ${this.state.dashboard.recentSales.map((item) => `<div class="soft-item"><b>${this.escape(item.number)}</b><span>${this.escape(item.client_name || 'Consumidor')} • ${this.date(item.sale_date)}</span><small>${this.money(item.total)}</small></div>`).join('')}
            </div>
          ` : `<p class="muted">Sem vendas registradas.</p>`}
        </article>
        <article class="card glow">
          <div class="card-head"><h3>Mapa rápido</h3></div>
          <p class="muted">Esta V2 já tem login, banco PostgreSQL, exportação e restauração de backup, vendas com baixa automática do estoque e stack pronta para Coolify.</p>
        </article>
      </div>
    `;
  },

  companyTemplate() {
    const c = this.state.company || {};
    return `
      <article class="card">
        <form id="companyForm" class="form-grid">
          <div class="field"><label>Nome fantasia</label><input name="name" value="${this.escape(c.name || '')}" required></div>
          <div class="field"><label>CNPJ</label><input name="cnpj" value="${this.escape(c.cnpj || '')}"></div>
          <div class="field"><label>Telefone</label><input name="phone" value="${this.escape(c.phone || '')}"></div>
          <div class="field"><label>E-mail</label><input name="email" value="${this.escape(c.email || '')}"></div>
          <div class="field full"><label>Endereço</label><input name="address" value="${this.escape(c.address || '')}"></div>
          <div class="field"><label>Cidade</label><input name="city" value="${this.escape(c.city || '')}"></div>
          <div class="field"><label>UF</label><input name="state" value="${this.escape(c.state || '')}"></div>
          <div class="field"><label>Responsável</label><input name="responsible" value="${this.escape(c.responsible || '')}"></div>
          <div class="field full"><label>Observações</label><textarea name="notes" rows="4">${this.escape(c.notes || '')}</textarea></div>
          <div class="actions full"><button class="primary-btn">Salvar dados</button></div>
        </form>
      </article>
    `;
  },

  clientsTemplate() {
    return `
      <div class="grid two">
        <article class="card">
          <div class="card-head"><h3>${this.state.editing.clientId ? 'Editar cliente' : 'Novo cliente'}</h3></div>
          <form id="clientForm" class="form-grid">
            <div class="field"><label>Nome</label><input name="name" required></div>
            <div class="field"><label>Telefone</label><input name="phone"></div>
            <div class="field"><label>CPF/CNPJ</label><input name="document"></div>
            <div class="field"><label>E-mail</label><input name="email"></div>
            <div class="field full"><label>Endereço</label><input name="address"></div>
            <div class="field full"><label>Observações</label><textarea name="notes" rows="3"></textarea></div>
            <div class="actions full">
              <button class="primary-btn">${this.state.editing.clientId ? 'Atualizar' : 'Salvar cliente'}</button>
              <button type="button" class="ghost-btn" id="clientClearBtn">Limpar</button>
            </div>
          </form>
        </article>
        <article class="card">
          <div class="card-head"><h3>Clientes cadastrados</h3></div>
          <div class="stack cards-list">
            ${this.state.clients.map((item) => `
              <div class="entity-card">
                <div><b>${this.escape(item.name)}</b><span>${this.escape(item.phone || 'Sem telefone')} • ${this.escape(item.document || 'Sem documento')}</span></div>
                <div class="row-actions">
                  <button class="mini-btn" data-action="edit-client" data-id="${item.id}">Editar</button>
                  <button class="mini-btn danger" data-action="delete-client" data-id="${item.id}">Excluir</button>
                </div>
              </div>
            `).join('') || '<p class="muted">Nenhum cliente ainda.</p>'}
          </div>
        </article>
      </div>
    `;
  },

  motorcyclesTemplate() {
    return `
      <div class="grid two">
        <article class="card">
          <div class="card-head"><h3>${this.state.editing.motorcycleId ? 'Editar moto' : 'Nova moto'}</h3></div>
          <form id="motorcycleForm" class="form-grid">
            ${this.clientSelectField({ selectId: 'motorcycleClientSelect' })}
            <div class="field"><label>Marca</label><input name="brand" required></div>
            <div class="field"><label>Modelo</label><input name="model" required></div>
            <div class="field"><label>Ano</label><input name="year"></div>
            <div class="field"><label>Placa</label><input name="plate"></div>
            <div class="field"><label>Chassi</label><input name="chassis"></div>
            <div class="field"><label>Cor</label><input name="color"></div>
            <div class="field"><label>KM</label><input name="km" type="number" min="0"></div>
            <div class="field full"><label>Observações</label><textarea name="notes" rows="3"></textarea></div>
            <div class="actions full">
              <button class="primary-btn">${this.state.editing.motorcycleId ? 'Atualizar' : 'Salvar moto'}</button>
              <button type="button" class="ghost-btn" id="motorcycleClearBtn">Limpar</button>
            </div>
          </form>
        </article>
        <article class="card">
          <div class="card-head"><h3>Motos cadastradas</h3></div>
          <div class="stack cards-list">
            ${this.state.motorcycles.map((item) => `
              <div class="entity-card">
                <div><b>${this.escape(item.brand)} ${this.escape(item.model)}</b><span>${this.escape(item.plate || 'Sem placa')} • ${this.escape(item.client_name || 'Sem cliente')}</span></div>
                <div class="row-actions">
                  <button class="mini-btn" data-action="edit-motorcycle" data-id="${item.id}">Editar</button>
                  <button class="mini-btn danger" data-action="delete-motorcycle" data-id="${item.id}">Excluir</button>
                </div>
              </div>
            `).join('') || '<p class="muted">Nenhuma moto ainda.</p>'}
          </div>
        </article>
      </div>
    `;
  },

  productsTemplate() {
    return `
      <div class="grid two">
        <article class="card">
          <div class="card-head"><h3>${this.state.editing.productId ? 'Editar produto' : 'Novo produto'}</h3></div>
          <form id="productForm" class="form-grid">
            <div class="field"><label>Produto</label><input name="name" required></div>
            <div class="field"><label>Código</label><input name="code"></div>
            <div class="field"><label>Fornecedor</label><input name="supplier"></div>
            <div class="field"><label>Categoria</label><input name="category"></div>
            <div class="field"><label>Custo</label><input name="cost" type="number" step="0.01"></div>
            <div class="field"><label>Preço</label><input name="price" type="number" step="0.01"></div>
            <div class="field"><label>Quantidade</label><input name="quantity" type="number" min="0"></div>
            <div class="field"><label>Mínimo</label><input name="min_quantity" type="number" min="0"></div>
            <div class="field full"><label>Observações</label><textarea name="notes" rows="3"></textarea></div>
            <div class="actions full">
              <button class="primary-btn">${this.state.editing.productId ? 'Atualizar' : 'Salvar produto'}</button>
              <button type="button" class="ghost-btn" id="productClearBtn">Limpar</button>
            </div>
          </form>
        </article>
        <article class="card">
          <div class="card-head"><h3>Estoque atual</h3></div>
          <div class="stack cards-list">
            ${this.state.products.map((item) => `
              <div class="entity-card ${Number(item.quantity) <= Number(item.min_quantity) ? 'danger-border' : ''}">
                <div><b>${this.escape(item.name)}</b><span>${this.escape(item.code || 'Sem código')} • Qtde ${item.quantity} • ${this.money(item.price)}</span></div>
                <div class="row-actions">
                  <button class="mini-btn" data-action="edit-product" data-id="${item.id}">Editar</button>
                  <button class="mini-btn danger" data-action="delete-product" data-id="${item.id}">Excluir</button>
                </div>
              </div>
            `).join('') || '<p class="muted">Sem produtos cadastrados.</p>'}
          </div>
        </article>
      </div>
    `;
  },

  budgetsTemplate() {
    return `
      <div class="grid two">
        <article class="card">
          <div class="card-head"><h3>${this.state.editing.budgetId ? 'Editar orçamento' : 'Novo orçamento'}</h3></div>
          <form id="budgetForm" class="form-grid">
            ${this.clientSelectField({ selectId: 'budgetClientSelect' })}
            <div class="field"><label>Moto</label><select name="motorcycle_id">${this.motorcycleOptions()}</select></div>
            <div class="field"><label>Data</label><input name="budget_date" type="date" value="${this.today()}"></div>
            <div class="field"><label>Validade</label><input name="valid_until" type="date"></div>
            <div class="field"><label>Status</label>
              <select name="status">
                <option>Aberto</option>
                <option>Aprovado</option>
                <option>Recusado</option>
                <option>Convertido em OS</option>
              </select>
            </div>
            <div class="field full"><label>Observações</label><textarea name="notes" rows="3"></textarea></div>
            <div class="field full">
              <div class="item-box">
                <div class="card-head compact"><h3>Itens</h3><button type="button" class="secondary-btn" id="addBudgetItemBtn">+ Item</button></div>
                <div id="budgetItems" class="item-list"></div>
              </div>
            </div>
            <div class="actions full">
              <button class="primary-btn">${this.state.editing.budgetId ? 'Atualizar' : 'Salvar orçamento'}</button>
              <button type="button" class="ghost-btn" id="budgetClearBtn">Limpar</button>
            </div>
          </form>
        </article>
        <article class="card">
          <div class="card-head"><h3>Orçamentos</h3></div>
          <div class="stack cards-list">
            ${this.state.budgets.map((item) => `
              <div class="entity-card">
                <div><b>${this.escape(item.number)}</b><span>${this.escape(item.client_name || 'Sem cliente')} • ${this.escape(item.status)} • ${this.money(item.total)}</span></div>
                <div class="row-actions wrap">
                  <button class="mini-btn" data-action="edit-budget" data-id="${item.id}">Editar</button>
                  <button class="mini-btn" data-action="convert-budget" data-id="${item.id}">Virar OS</button>
                  <button class="mini-btn danger" data-action="delete-budget" data-id="${item.id}">Excluir</button>
                </div>
              </div>
            `).join('') || '<p class="muted">Sem orçamentos ainda.</p>'}
          </div>
        </article>
      </div>
    `;
  },

  ordersTemplate() {
    return `
      <div class="grid two">
        <article class="card">
          <div class="card-head"><h3>${this.state.editing.orderId ? 'Editar OS' : 'Nova OS'}</h3></div>
          <form id="orderForm" class="form-grid">
            ${this.clientSelectField({ selectId: 'orderClientSelect' })}
            <div class="field"><label>Moto</label><select name="motorcycle_id">${this.motorcycleOptions()}</select></div>
            <div class="field"><label>Orçamento vinculado</label><select name="budget_id">${this.budgetOptions()}</select></div>
            <div class="field"><label>Data</label><input name="service_date" type="date" value="${this.today()}"></div>
            <div class="field"><label>Status</label>
              <select name="status">
                <option>Aberta</option>
                <option>Em andamento</option>
                <option>Concluída</option>
                <option>Entregue</option>
              </select>
            </div>
            <div class="field full"><label>Defeito relatado</label><textarea name="complaint" rows="2"></textarea></div>
            <div class="field full"><label>Diagnóstico</label><textarea name="diagnosis" rows="2"></textarea></div>
            <div class="field full"><label>Serviços executados</label><textarea name="services_performed" rows="3"></textarea></div>
            <div class="field"><label>Mão de obra</label><input name="labor_price" type="number" step="0.01"></div>
            <div class="field"><label>Peças</label><input name="parts_total" type="number" step="0.01"></div>
            <div class="field full"><label>Observações</label><textarea name="notes" rows="2"></textarea></div>
            <div class="actions full">
              <button class="primary-btn">${this.state.editing.orderId ? 'Atualizar' : 'Salvar OS'}</button>
              <button type="button" class="ghost-btn" id="orderClearBtn">Limpar</button>
            </div>
          </form>
        </article>
        <article class="card">
          <div class="card-head"><h3>Ordens de serviço</h3></div>
          <div class="stack cards-list">
            ${this.state.orders.map((item) => `
              <div class="entity-card">
                <div><b>${this.escape(item.number)}</b><span>${this.escape(item.client_name || 'Sem cliente')} • ${this.escape(item.status)} • ${this.money(item.total)}</span></div>
                <div class="row-actions wrap">
                  <button class="mini-btn" data-action="edit-order" data-id="${item.id}">Editar</button>
                  <button class="mini-btn secondary" data-action="order-to-fiscal" data-id="${item.id}">Pré-nota</button>
                  <button class="mini-btn danger" data-action="delete-order" data-id="${item.id}">Excluir</button>
                </div>
              </div>
            `).join('') || '<p class="muted">Sem ordens de serviço.</p>'}
          </div>
        </article>
      </div>
    `;
  },

  salesTemplate() {
    return `
      <div class="grid two">
        <article class="card">
          <div class="card-head"><h3>Nova venda</h3></div>
          <form id="saleForm" class="form-grid">
            ${this.clientSelectField({ includeEmpty: true, selectId: 'saleClientSelect' })}
            <div class="field"><label>Data</label><input name="sale_date" type="date" value="${this.today()}"></div>
            <div class="field"><label>Pagamento</label>
              <select name="payment_method">
                <option>Pix</option><option>Dinheiro</option><option>Cartão</option><option>Fiado</option>
              </select>
            </div>
            <div class="field full"><label>Observações</label><textarea name="notes" rows="2"></textarea></div>
            <div class="field full">
              <div class="item-box">
                <div class="card-head compact"><h3>Itens da venda</h3><button type="button" class="secondary-btn" id="addSaleItemBtn">+ Item</button></div>
                <div id="saleItems" class="item-list"></div>
              </div>
            </div>
            <div class="actions full"><button class="primary-btn">Registrar venda</button></div>
          </form>
        </article>
        <article class="card">
          <div class="card-head"><h3>Vendas lançadas</h3></div>
          <div class="stack cards-list">
            ${this.state.sales.map((item) => `
              <div class="entity-card">
                <div><b>${this.escape(item.number)}</b><span>${this.escape(item.client_name || 'Consumidor')} • ${this.escape(item.payment_method)} • ${this.money(item.total)}</span></div>
                <div class="row-actions"><button class="mini-btn danger" data-action="delete-sale" data-id="${item.id}">Excluir</button></div>
              </div>
            `).join('') || '<p class="muted">Sem vendas ainda.</p>'}
          </div>
        </article>
      </div>
    `;
  },

  receiptsTemplate() {
    return `
      <div class="grid two">
        <article class="card">
          <div class="card-head"><h3>Novo recibo</h3></div>
          <form id="receiptForm" class="form-grid">
            ${this.clientSelectField({ includeEmpty: true, selectId: 'receiptClientSelect' })}
            <div class="field"><label>Data</label><input name="receipt_date" type="date" value="${this.today()}"></div>
            <div class="field"><label>Valor</label><input name="amount" type="number" step="0.01"></div>
            <div class="field"><label>Pagamento</label><select name="payment_method"><option>Pix</option><option>Dinheiro</option><option>Cartão</option></select></div>
            <div class="field"><label>Referência</label><select name="reference_type"><option>manual</option><option>sale</option><option>service_order</option></select></div>
            <div class="field full"><label>Observações</label><textarea name="notes" rows="3"></textarea></div>
            <div class="actions full"><button class="primary-btn">Salvar recibo</button></div>
          </form>
        </article>
        <article class="card">
          <div class="card-head"><h3>Recibos emitidos</h3></div>
          <div class="stack cards-list">
            ${this.state.receipts.map((item) => `
              <div class="entity-card">
                <div><b>${this.escape(item.number)}</b><span>${this.escape(item.client_name || 'Sem cliente')} • ${this.date(item.receipt_date)} • ${this.money(item.amount)}</span></div>
                <div class="row-actions"><button class="mini-btn danger" data-action="delete-receipt" data-id="${item.id}">Excluir</button></div>
              </div>
            `).join('') || '<p class="muted">Nenhum recibo ainda.</p>'}
          </div>
        </article>
      </div>
    `;
  },

  financeTemplate() {
    return `
      <div class="grid two">
        <article class="card">
          <div class="card-head"><h3>${this.state.editing.financeId ? 'Editar lançamento' : 'Novo lançamento'}</h3></div>
          <form id="financeForm" class="form-grid">
            <div class="field"><label>Tipo</label><select name="entry_type"><option value="entrada">Entrada</option><option value="saida">Saída</option></select></div>
            <div class="field"><label>Categoria</label><input name="category"></div>
            <div class="field full"><label>Descrição</label><input name="description" required></div>
            <div class="field"><label>Valor</label><input name="amount" type="number" step="0.01" required></div>
            <div class="field"><label>Vencimento</label><input name="due_date" type="date"></div>
            <div class="field"><label>Pago em</label><input name="paid_at" type="date"></div>
            <div class="field"><label>Status</label><select name="status"><option>Pendente</option><option>Pago</option></select></div>
            <div class="actions full">
              <button class="primary-btn">${this.state.editing.financeId ? 'Atualizar' : 'Salvar lançamento'}</button>
              <button type="button" class="ghost-btn" id="financeClearBtn">Limpar</button>
            </div>
          </form>
        </article>
        <article class="card">
          <div class="card-head"><h3>Fluxo financeiro</h3></div>
          <div class="stack cards-list">
            ${this.state.finance.map((item) => `
              <div class="entity-card ${item.entry_type === 'saida' ? 'danger-border' : ''}">
                <div><b>${this.escape(item.description)}</b><span>${this.escape(item.entry_type)} • ${this.escape(item.status)} • ${this.money(item.amount)}</span></div>
                <div class="row-actions">
                  <button class="mini-btn" data-action="edit-finance" data-id="${item.id}">Editar</button>
                  <button class="mini-btn danger" data-action="delete-finance" data-id="${item.id}">Excluir</button>
                </div>
              </div>
            `).join('') || '<p class="muted">Sem lançamentos.</p>'}
          </div>
        </article>
      </div>
    `;
  },


  fiscalTemplate() {
    const cert = this.state.fiscalCertificate || {};
    const latestNfse = this.state.fiscal.find((item) => String(item.doc_type || '').toUpperCase().includes('NFS'));
    const latestData = latestNfse ? this.parseFiscalNotes(latestNfse) : {};
    const defaultCity = this.state.company?.city ? `${this.state.company.city}${this.state.company?.state ? ` - ${this.state.company.state}` : ''}` : 'Muriaé - MG';
    const defaultCode = latestData.service_code || '14.03.01';
    const certStatus = cert.is_configured ? 'Configurado' : 'Pendente';
    const envLabel = cert.environment === 'producao' ? 'Produção' : 'Homologação';
    return `
      <div class="grid">
        <article class="card glow">
          <div class="card-head"><h3>Certificado digital A1</h3></div>
          <p class="muted">Suba o arquivo .pfx ou .p12, informe a senha e deixe a leitura do certificado pronta dentro do sistema. A emissão automática ainda depende da integração com a prefeitura ou provedor fiscal.</p>
          <div class="summary-box top-gap certificate-summary">
            <div class="row"><span>Status</span><b class="status-pill ${cert.is_configured ? 'ok' : 'warn'}">${this.escape(certStatus)}</b></div>
            <div class="row"><span>Ambiente</span><b>${this.escape(envLabel)}</b></div>
            <div class="row"><span>Arquivo</span><b>${this.escape(cert.certificate_filename || '-')}</b></div>
            <div class="row"><span>Titular</span><b>${this.escape(cert.subject_name || '-')}</b></div>
            <div class="row"><span>Documento</span><b>${this.escape(cert.document_number || '-')}</b></div>
            <div class="row"><span>Emissor</span><b>${this.escape(cert.issuer_name || '-')}</b></div>
            <div class="row"><span>Validade</span><b>${cert.valid_until ? this.date(cert.valid_until) : '-'}</b></div>
            <div class="row"><span>Último teste</span><b>${cert.last_tested_at ? new Date(cert.last_tested_at).toLocaleString('pt-BR') : '-'}</b></div>
          </div>
          <form id="fiscalCertForm" class="form-grid top-gap">
            <div class="field"><label>Provedor / prefeitura</label><input name="provider_name" value="${this.escape(cert.provider_name || '')}" placeholder="Ex.: Portal Nacional NFS-e, prefeitura, provedor"></div>
            <div class="field"><label>Ambiente</label><select name="environment"><option value="homologacao" ${cert.environment !== 'producao' ? 'selected' : ''}>Homologação</option><option value="producao" ${cert.environment === 'producao' ? 'selected' : ''}>Produção</option></select></div>
            <div class="field full"><label>Arquivo do certificado (.pfx ou .p12)</label><input name="certificate_file" type="file" accept=".pfx,.p12,application/x-pkcs12"></div>
            <div class="field"><label>Senha do certificado</label><input name="certificate_password" type="password" placeholder="Digite para salvar ou trocar"></div>
            <div class="field"><label>Armazenamento</label><input value="Protegido no servidor /data/certs" readonly></div>
            <div class="actions full">
              <button class="primary-btn">Salvar certificado</button>
              <button type="button" class="secondary-btn" id="testFiscalCertBtn">Testar leitura</button>
              <button type="button" class="ghost-btn danger" id="deleteFiscalCertBtn">Remover certificado</button>
            </div>
          </form>
        </article>
        <div class="grid two">
          <article class="card glow">
            <div class="card-head"><h3>Pré-nota de serviço</h3></div>
            <p class="muted">Monte a NFS-e no sistema, copie os dados e finalize no portal. Ideal para oficina sem tropeço fiscal.</p>
            <form id="fiscalForm" class="form-grid top-gap">
              <div class="field">
                <label>Ordem de serviço</label>
                <select name="reference_id" id="fiscalOrderSelect">
                  <option value="">Sem vínculo</option>
                  ${this.state.orders.map((item) => `<option value="${item.id}">${this.escape(item.number)} • ${this.escape(item.client_name || 'Sem cliente')}</option>`).join('')}
                </select>
              </div>
              ${this.clientSelectField({ includeEmpty: true, selectId: 'fiscalClientSelect' })}
              <div class="field"><label>Data do serviço</label><input name="service_date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
              <div class="field"><label>Valor do serviço</label><input name="service_value" type="number" step="0.01" min="0" placeholder="0,00"></div>
              <div class="field"><label>Código do serviço</label><input name="service_code" value="${this.escape(defaultCode)}"></div>
              <div class="field"><label>Município da prestação</label><input name="service_city" value="${this.escape(defaultCity)}"></div>
              <div class="field full"><label>Descrição do serviço</label><textarea name="service_description" rows="4" placeholder="Ex.: revisão, troca de pneus, mão de obra, peças cobradas no serviço"></textarea></div>
              <div class="field"><label>Tomador / cliente</label><input name="customer_name" placeholder="Nome ou razão social"></div>
              <div class="field"><label>CPF/CNPJ do cliente</label><input name="customer_document" placeholder="CPF ou CNPJ"></div>
              <div class="field"><label>E-mail do cliente</label><input name="customer_email" type="email" placeholder="email@cliente.com"></div>
              <div class="field"><label>Status</label><select name="status"><option>Pendente de emissão</option><option>Pronta para emitir</option><option>Emitida no portal</option></select></div>
              <div class="field full"><label>Endereço do cliente</label><textarea name="customer_address" rows="2" placeholder="Endereço completo do tomador"></textarea></div>
              <div class="field full"><label>Observações para a nota</label><textarea name="notes" rows="3" placeholder="Informações extras, garantia, forma de cobrança, etc."></textarea></div>
              <div class="field full">
                <label>Texto pronto para copiar no portal</label>
                <textarea id="fiscalPreview" rows="10" readonly placeholder="A pré-nota vai aparecer aqui."></textarea>
              </div>
              <div class="actions full">
                <button class="primary-btn">Salvar pré-nota</button>
                <button type="button" class="secondary-btn" id="copyFiscalPreviewBtn">Copiar texto</button>
                <button type="button" class="secondary-btn" id="emitFiscalBtn">Emitir nota fiscal</button>
                <button type="button" class="ghost-btn" id="checkFiscalStatusBtn">Consultar status</button>
                <button type="button" class="ghost-btn" id="clearFiscalBtn">Limpar</button>
              </div>
              <div class="field full">
                <label>Retorno da emissão</label>
                <textarea id="fiscalEmitResult" rows="6" readonly placeholder="O retorno da emissão vai aparecer aqui."></textarea>
              </div>
            </form>
          </article>
          <article class="card">
            <div class="card-head"><h3>Fila de pré-notas</h3></div>
            <div class="stack cards-list">
              ${this.state.fiscal.map((item) => {
                const details = this.parseFiscalNotes(item);
                const title = details.customer_name || details.service_description || item.doc_type;
                const sub = [details.service_date ? this.date(details.service_date) : null, details.service_value ? this.money(details.service_value) : null, details.service_code || null].filter(Boolean).join(' • ');
                return `
                  <div class="entity-card fiscal-card">
                    <div>
                      <b>${this.escape(item.doc_type)} • ${this.escape(title)}</b>
                      <span>${this.escape(item.status)} • ${this.escape(item.reference_type || 'manual')}</span>
                      <span>${this.escape(sub || (details.raw_notes || 'Sem detalhes.'))}</span>
                    </div>
                    <div class="row-actions wrap">
                      <button class="mini-btn" data-action="copy-fiscal" data-id="${item.id}">Copiar</button>
                      <button class="mini-btn secondary" data-action="emit-fiscal" data-id="${item.id}">Emitir</button>
                      <button class="mini-btn" data-action="status-fiscal" data-id="${item.id}">Status</button>
                      <button class="mini-btn danger" data-action="delete-fiscal" data-id="${item.id}">Excluir</button>
                    </div>
                  </div>
                `;
              }).join('') || '<p class="muted">Sem pré-notas salvas.</p>'}
            </div>
          </article>
        </div>
      </div>
    `;
  },

  backupTemplate() {
    const reports = this.state.reports || { salesByMonth: [], topProducts: [], financeSummary: [] };
    return `
      <div class="grid two">
        <article class="card">
          <div class="card-head"><h3>Backup</h3></div>
          <div class="button-stack">
            <button class="primary-btn" id="exportBackupBtn">Exportar backup JSON</button>
            <label class="secondary-btn file-label">Importar backup JSON<input type="file" id="importBackupInput" accept="application/json,.json" hidden></label>
            <button class="ghost-btn" id="demoDataBtn">Carregar dados demo</button>
          </div>
        </article>
        <article class="card">
          <div class="card-head"><h3>Relatório resumido</h3></div>
          <div class="summary-box">
            <strong>Financeiro</strong>
            ${reports.financeSummary.map((item) => `<div class="row"><span>${this.escape(item.entry_type)}</span><b>${this.money(item.total)}</b></div>`).join('') || '<p class="muted">Sem dados.</p>'}
          </div>
        </article>
      </div>
      <div class="grid two">
        <article class="card">
          <div class="card-head"><h3>Vendas por mês</h3></div>
          <div class="stack">
            ${reports.salesByMonth.map((item) => `<div class="row"><span>${this.escape(item.month)}</span><b>${this.money(item.total)}</b></div>`).join('') || '<p class="muted">Sem vendas.</p>'}
          </div>
        </article>
        <article class="card">
          <div class="card-head"><h3>Produtos mais vendidos</h3></div>
          <div class="stack">
            ${reports.topProducts.map((item) => `<div class="row"><span>${this.escape(item.description)}</span><b>${item.quantity} un • ${this.money(item.total)}</b></div>`).join('') || '<p class="muted">Sem produtos vendidos.</p>'}
          </div>
        </article>
      </div>
    `;
  },

  bindSection(section) {
    if (section === 'empresa') {
      document.getElementById('companyForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const body = this.formToObject(event.currentTarget);
        await this.safeAction(async () => {
          this.state.company = await this.api('/company', { method: 'PUT', body });
          this.toast('Dados da empresa atualizados.');
        });
      });
    }

    if (section === 'clientes') {
      const form = document.getElementById('clientForm');
      if (this.state.editing.clientId) this.fillForm(form, this.state.clients.find((item) => item.id === this.state.editing.clientId));
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const body = this.formToObject(form);
        await this.safeAction(async () => {
          if (this.state.editing.clientId) {
            await this.api(`/clients/${this.state.editing.clientId}`, { method: 'PUT', body });
          } else {
            await this.api('/clients', { method: 'POST', body });
          }
          this.resetEditing('clientId');
          await this.loadAll();
          this.toast('Cliente salvo.');
        });
      });
      document.getElementById('clientClearBtn').addEventListener('click', () => { this.resetEditing('clientId'); this.renderSection('clientes'); });
      this.bindListActions({
        'edit-client': (id) => { this.state.editing.clientId = Number(id); this.renderSection('clientes'); },
        'delete-client': (id) => this.safeDelete(`/clients/${id}`, 'Cliente excluído.'),
      });
    }

    if (section === 'motos') {
      const form = document.getElementById('motorcycleForm');
      if (this.state.editing.motorcycleId) this.fillForm(form, this.state.motorcycles.find((item) => item.id === this.state.editing.motorcycleId));
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const body = this.formToObject(form);
        await this.safeAction(async () => {
          if (this.state.editing.motorcycleId) {
            await this.api(`/motorcycles/${this.state.editing.motorcycleId}`, { method: 'PUT', body });
          } else {
            await this.api('/motorcycles', { method: 'POST', body });
          }
          this.resetEditing('motorcycleId');
          await this.loadAll();
          this.toast('Moto salva.');
        });
      });
      document.getElementById('motorcycleClearBtn').addEventListener('click', () => { this.resetEditing('motorcycleId'); this.renderSection('motos'); });
      this.bindListActions({
        'edit-motorcycle': (id) => { this.state.editing.motorcycleId = Number(id); this.renderSection('motos'); },
        'delete-motorcycle': (id) => this.safeDelete(`/motorcycles/${id}`, 'Moto excluída.'),
      });
    }

    if (section === 'estoque') {
      const form = document.getElementById('productForm');
      if (this.state.editing.productId) this.fillForm(form, this.state.products.find((item) => item.id === this.state.editing.productId));
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const body = this.formToObject(form);
        await this.safeAction(async () => {
          if (this.state.editing.productId) {
            await this.api(`/products/${this.state.editing.productId}`, { method: 'PUT', body });
          } else {
            await this.api('/products', { method: 'POST', body });
          }
          this.resetEditing('productId');
          await this.loadAll();
          this.toast('Produto salvo.');
        });
      });
      document.getElementById('productClearBtn').addEventListener('click', () => { this.resetEditing('productId'); this.renderSection('estoque'); });
      this.bindListActions({
        'edit-product': (id) => { this.state.editing.productId = Number(id); this.renderSection('estoque'); },
        'delete-product': (id) => this.safeDelete(`/products/${id}`, 'Produto excluído.'),
      });
    }

    if (section === 'orcamentos') {
      const form = document.getElementById('budgetForm');
      const itemsBox = document.getElementById('budgetItems');
      const current = this.state.budgets.find((item) => item.id === this.state.editing.budgetId);
      if (current) {
        this.fillForm(form, current);
        (current.items || []).forEach((item) => this.appendBudgetItem(itemsBox, item));
      }
      if (!itemsBox.children.length) this.appendBudgetItem(itemsBox);
      document.getElementById('addBudgetItemBtn').addEventListener('click', () => this.appendBudgetItem(itemsBox));
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const body = this.formToObject(form);
        body.items = this.collectItems(itemsBox, false);
        await this.safeAction(async () => {
          if (this.state.editing.budgetId) {
            await this.api(`/budgets/${this.state.editing.budgetId}`, { method: 'PUT', body });
          } else {
            await this.api('/budgets', { method: 'POST', body });
          }
          this.resetEditing('budgetId');
          await this.loadAll();
          this.toast('Orçamento salvo.');
        });
      });
      document.getElementById('budgetClearBtn').addEventListener('click', () => { this.resetEditing('budgetId'); this.renderSection('orcamentos'); });
      this.bindListActions({
        'edit-budget': (id) => { this.state.editing.budgetId = Number(id); this.renderSection('orcamentos'); },
        'delete-budget': (id) => this.safeDelete(`/budgets/${id}`, 'Orçamento excluído.'),
        'convert-budget': (id) => this.safeAction(async () => { await this.api(`/budgets/${id}/convert-service-order`, { method: 'POST' }); await this.loadAll(); this.toast('Orçamento convertido em OS.'); }),
      });
    }

    if (section === 'os') {
      const form = document.getElementById('orderForm');
      if (this.state.editing.orderId) this.fillForm(form, this.state.orders.find((item) => item.id === this.state.editing.orderId));
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const body = this.formToObject(form);
        await this.safeAction(async () => {
          if (this.state.editing.orderId) {
            await this.api(`/service-orders/${this.state.editing.orderId}`, { method: 'PUT', body });
          } else {
            await this.api('/service-orders', { method: 'POST', body });
          }
          this.resetEditing('orderId');
          await this.loadAll();
          this.toast('OS salva.');
        });
      });
      document.getElementById('orderClearBtn').addEventListener('click', () => { this.resetEditing('orderId'); this.renderSection('os'); });
      this.bindListActions({
        'edit-order': (id) => { this.state.editing.orderId = Number(id); this.renderSection('os'); },
        'order-to-fiscal': (id) => this.openFiscalForOrder(id),
        'delete-order': (id) => this.safeDelete(`/service-orders/${id}`, 'OS excluída.'),
      });
    }

    if (section === 'vendas') {
      const form = document.getElementById('saleForm');
      const itemsBox = document.getElementById('saleItems');
      this.appendSaleItem(itemsBox);
      document.getElementById('addSaleItemBtn').addEventListener('click', () => this.appendSaleItem(itemsBox));
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const body = this.formToObject(form);
        body.items = this.collectItems(itemsBox, true);
        await this.safeAction(async () => {
          await this.api('/sales', { method: 'POST', body });
          await this.loadAll();
          this.renderSection('vendas');
          this.toast('Venda registrada.');
        });
      });
      this.bindListActions({
        'delete-sale': (id) => this.safeDelete(`/sales/${id}`, 'Venda excluída.'),
      });
    }

    if (section === 'recibos') {
      document.getElementById('receiptForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const body = this.formToObject(event.currentTarget);
        await this.safeAction(async () => {
          await this.api('/receipts', { method: 'POST', body });
          await this.loadAll();
          this.renderSection('recibos');
          this.toast('Recibo salvo.');
        });
      });
      this.bindListActions({
        'delete-receipt': (id) => this.safeDelete(`/receipts/${id}`, 'Recibo excluído.'),
      });
    }

    if (section === 'financeiro') {
      const form = document.getElementById('financeForm');
      if (this.state.editing.financeId) this.fillForm(form, this.state.finance.find((item) => item.id === this.state.editing.financeId));
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const body = this.formToObject(form);
        await this.safeAction(async () => {
          if (this.state.editing.financeId) {
            await this.api(`/finance/${this.state.editing.financeId}`, { method: 'PUT', body });
          } else {
            await this.api('/finance', { method: 'POST', body });
          }
          this.resetEditing('financeId');
          await this.loadAll();
          this.toast('Lançamento salvo.');
        });
      });
      document.getElementById('financeClearBtn').addEventListener('click', () => { this.resetEditing('financeId'); this.renderSection('financeiro'); });
      this.bindListActions({
        'edit-finance': (id) => { this.state.editing.financeId = Number(id); this.renderSection('financeiro'); },
        'delete-finance': (id) => this.safeDelete(`/finance/${id}`, 'Lançamento excluído.'),
      });
    }


    if (section === 'fiscal') {
      const certForm = document.getElementById('fiscalCertForm');
      const testCertBtn = document.getElementById('testFiscalCertBtn');
      const deleteCertBtn = document.getElementById('deleteFiscalCertBtn');

      certForm?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const file = certForm.elements.certificate_file?.files?.[0] || null;
        const password = String(certForm.elements.certificate_password?.value || '').trim();
        await this.safeAction(async () => {
          const body = {
            provider_name: certForm.elements.provider_name?.value || '',
            environment: certForm.elements.environment?.value || 'homologacao',
          };
          if (file) {
            body.certificate_filename = file.name;
            body.certificate_base64 = await this.fileToDataUrl(file);
          }
          if (password) {
            body.certificate_password = password;
          }
          const response = await this.api('/fiscal/certificate', { method: 'PUT', body });
          this.state.fiscalCertificate = response.certificate;
          await this.loadAll();
          this.toast(response.message || 'Certificado salvo com sucesso.');
        });
      });

      testCertBtn?.addEventListener('click', async () => {
        await this.safeAction(async () => {
          const response = await this.api('/fiscal/certificate/test', { method: 'POST' });
          this.state.fiscalCertificate = response.certificate;
          await this.loadAll();
          this.toast(response.message || 'Certificado testado com sucesso.');
        });
      });

      deleteCertBtn?.addEventListener('click', async () => {
        if (!confirm('Remover o certificado salvo do sistema?')) return;
        await this.safeAction(async () => {
          const response = await this.api('/fiscal/certificate', { method: 'DELETE' });
          this.state.fiscalCertificate = response.certificate;
          await this.loadAll();
          this.toast(response.message || 'Certificado removido.');
        });
      });

      const form = document.getElementById('fiscalForm');
      const orderSelect = document.getElementById('fiscalOrderSelect');
      const clientSelect = document.getElementById('fiscalClientSelect');
      const previewFields = ['service_date', 'service_value', 'service_code', 'service_city', 'service_description', 'customer_name', 'customer_document', 'customer_email', 'customer_address', 'notes'];

      orderSelect?.addEventListener('change', () => {
        this.prefillFiscalOrder(form, orderSelect.value);
        this.syncFiscalPreview(form);
      });

      clientSelect?.addEventListener('change', () => {
        this.prefillFiscalClient(form, clientSelect.value);
        this.syncFiscalPreview(form);
      });

      previewFields.forEach((name) => {
        form.elements[name]?.addEventListener('input', () => this.syncFiscalPreview(form));
      });
      form.elements.status?.addEventListener('change', () => this.syncFiscalPreview(form));

      document.getElementById('copyFiscalPreviewBtn').addEventListener('click', async () => {
        await this.copyText(document.getElementById('fiscalPreview')?.value || '');
      });

      document.getElementById('clearFiscalBtn').addEventListener('click', () => {
        form.reset();
        form.elements.service_city.value = this.state.company?.city ? `${this.state.company.city}${this.state.company?.state ? ` - ${this.state.company.state}` : ''}` : 'Muriaé - MG';
        form.elements.service_code.value = '14.03.01';
        this.syncFiscalPreview(form);
      });

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        await this.safeAction(async () => {
          await this.saveCurrentFiscalDraft(form);
          await this.loadAll();
          this.toast('Pré-nota salva na fila fiscal.');
        });
      });

      document.getElementById('emitFiscalBtn')?.addEventListener('click', async () => {
        await this.safeAction(async () => {
          const saved = await this.saveCurrentFiscalDraft(form);
          const response = await this.emitFiscalDocument(saved.id);
          await this.loadAll();
          this.renderFiscalEmitResult(response.document);
          this.toast(response.message || 'Nota fiscal enviada.');
        });
      });

      document.getElementById('checkFiscalStatusBtn')?.addEventListener('click', async () => {
        await this.safeAction(async () => {
          const latest = this.state.fiscal[0];
          if (!latest) throw new Error('Salve ou emita uma pré-nota antes de consultar o status.');
          const response = await this.fetchFiscalStatus(latest.id);
          this.renderFiscalEmitResult(response.document);
          this.toast('Status atualizado.');
        });
      });

      if (this.state.pendingFiscalOrderId) {
        const pendingId = String(this.state.pendingFiscalOrderId);
        if (orderSelect) orderSelect.value = pendingId;
        this.prefillFiscalOrder(form, pendingId);
        this.syncFiscalPreview(form);
        this.state.pendingFiscalOrderId = null;
        this.toast('OS carregada na pré-nota fiscal.');
      } else {
        this.syncFiscalPreview(form);
      }
      this.bindListActions({
        'copy-fiscal': async (id) => {
          const item = this.state.fiscal.find((entry) => String(entry.id) === String(id));
          const details = this.parseFiscalNotes(item);
          await this.copyText(this.fiscalPreviewText(details));
        },
        'emit-fiscal': async (id) => {
          await this.safeAction(async () => {
            const response = await this.emitFiscalDocument(id);
            await this.loadAll();
            this.renderFiscalEmitResult(response.document);
            this.toast(response.message || 'Nota fiscal enviada.');
          });
        },
        'status-fiscal': async (id) => {
          await this.safeAction(async () => {
            const response = await this.fetchFiscalStatus(id);
            this.renderFiscalEmitResult(response.document);
            this.toast('Status atualizado.');
          });
        },
        'delete-fiscal': (id) => this.safeDelete(`/fiscal-documents/${id}`, 'Pré-nota excluída.'),
      });
    }

    if (section === 'backup') {
      document.getElementById('exportBackupBtn').addEventListener('click', async () => {
        await this.safeAction(async () => {
          const data = await this.api('/backup/export');
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = `jg-motos-backup-${new Date().toISOString().slice(0, 10)}.json`;
          link.click();
          URL.revokeObjectURL(url);
          this.toast('Backup exportado.');
        });
      });
      document.getElementById('importBackupInput').addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        const content = JSON.parse(await file.text());
        await this.safeAction(async () => {
          await this.api('/backup/import', { method: 'POST', body: content });
          await this.loadAll();
          this.toast('Backup restaurado.');
        });
      });
      document.getElementById('demoDataBtn').addEventListener('click', async () => {
        await this.safeAction(async () => {
          const data = await this.api('/setup/demo', { method: 'POST' });
          await this.loadAll();
          this.toast(data.message || 'Dados demo carregados.');
        });
      });
    }

    this.bindSearchableSelects(document.getElementById('view'));
  },

  bindListActions(actions) {
    document.getElementById('view').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const action = actions[button.dataset.action];
      if (action) await action(button.dataset.id);
    });
  },

  bindSearchableSelects(root = document) {
    root.querySelectorAll('.select-filter-input[data-filter-target]').forEach((input) => {
      const select = root.querySelector(`#${input.dataset.filterTarget}`);
      if (!select) return;

      const buildOptionCache = () => {
        select._allOptions = [...select.options].map((option, index) => ({
          value: option.value,
          text: option.textContent,
          isPlaceholder: index === 0,
        }));
      };

      buildOptionCache();

      const renderOptions = (query = '') => {
        if (!select._allOptions || !select._allOptions.length) buildOptionCache();
        const currentValue = select.value;
        const normalized = this.normalizeText(query);
        const filtered = select._allOptions.filter((option) => {
          if (option.isPlaceholder) return true;
          if (!normalized) return true;
          const haystack = this.normalizeText(option.text);
          return haystack.includes(normalized);
        });

        select.innerHTML = filtered.map((option) => `<option value="${this.escape(option.value)}">${this.escape(option.text)}</option>`).join('');

        const hasCurrent = filtered.some((option) => String(option.value) === String(currentValue));
        if (hasCurrent) {
          select.value = currentValue;
        } else if (filtered.length === 2 && filtered[0].isPlaceholder) {
          select.value = String(filtered[1].value);
        } else {
          select.value = '';
        }
      };

      const syncInputFromSelection = () => {
        const selected = select.selectedOptions[0];
        if (select.value && selected) {
          input.value = selected.textContent;
        }
      };

      renderOptions('');
      if (select.value) syncInputFromSelection();

      input.addEventListener('input', () => {
        renderOptions(input.value);
      });

      input.addEventListener('focus', () => {
        renderOptions(input.value);
      });

      input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          input.value = '';
          renderOptions('');
          select.value = '';
          return;
        }

        if (event.key === 'Enter') {
          event.preventDefault();
          const firstMatch = [...select.options].find((option, index) => index > 0 && option.value);
          if (firstMatch) {
            select.value = firstMatch.value;
            syncInputFromSelection();
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      });

      select.addEventListener('change', () => {
        syncInputFromSelection();
      });
    });
  },


  parseFiscalNotes(item) {
    if (!item) return {};
    try {
      const parsed = typeof item.notes === 'string' ? JSON.parse(item.notes || '{}') : (item.notes || {});
      return parsed && typeof parsed === 'object' ? parsed : { raw_notes: String(item.notes || '') };
    } catch (_error) {
      return { raw_notes: String(item.notes || '') };
    }
  },

  fiscalPreviewText(payload = {}) {
    return [
      'NFS-e | Pré-nota de serviço',
      `Cliente: ${payload.customer_name || '-'}`,
      `CPF/CNPJ: ${payload.customer_document || '-'}`,
      `Endereço: ${payload.customer_address || '-'}`,
      `E-mail: ${payload.customer_email || '-'}`,
      `Data do serviço: ${payload.service_date ? this.date(payload.service_date) : '-'}`,
      `Município da prestação: ${payload.service_city || '-'}`,
      `Código do serviço: ${payload.service_code || '-'}`,
      `Valor do serviço: ${this.money(payload.service_value || 0)}`,
      `Descrição do serviço: ${payload.service_description || '-'}`,
      `Observações: ${payload.notes || '-'}`,
    ].join('\n');
  },

  syncFiscalPreview(form) {
    const preview = document.getElementById('fiscalPreview');
    if (!preview || !form) return;
    const payload = this.formToObject(form);
    preview.value = this.fiscalPreviewText(payload);
  },

  fiscalEmitResultText(item) {
    if (!item) return '';
    const lines = [
      `Status: ${item.status || '-'}`,
      `Número NFS-e: ${item.nfse_number || '-'}`,
      `Chave: ${item.access_key || '-'}`,
      `Protocolo: ${item.protocol || '-'}`,
      `Emitida em: ${item.emitted_at ? this.dateTime(item.emitted_at) : '-'}`,
    ];
    const details = item.provider_response ? this.tryPrettyJson(item.provider_response) : '';
    return [lines.join('\n'), details].filter(Boolean).join('\n\n');
  },

  dateTime(value) {
    if (!value) return '-';
    return new Date(value).toLocaleString('pt-BR');
  },

  tryPrettyJson(value) {
    try {
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      return JSON.stringify(parsed, null, 2);
    } catch (_error) {
      return String(value || '');
    }
  },

  async saveCurrentFiscalDraft(form) {
    const payload = this.formToObject(form);
    return this.api('/fiscal-documents', {
      method: 'POST',
      body: {
        doc_type: 'NFS-e',
        status: payload.status || 'Pendente de emissão',
        reference_type: payload.reference_id ? 'service_order' : 'manual',
        reference_id: payload.reference_id || null,
        notes: JSON.stringify(payload),
      },
    });
  },

  async emitFiscalDocument(id) {
    return this.api(`/fiscal-documents/${id}/emit`, { method: 'POST' });
  },

  async fetchFiscalStatus(id) {
    return this.api(`/fiscal-documents/${id}/status`, { method: 'POST' });
  },

  renderFiscalEmitResult(item) {
    const box = document.getElementById('fiscalEmitResult');
    if (!box) return;
    box.value = this.fiscalEmitResultText(item);
  },

  prefillFiscalClient(form, clientId) {
    const client = this.state.clients.find((item) => String(item.id) === String(clientId));
    if (!client || !form) return;
    form.elements.customer_name.value = client.name || '';
    form.elements.customer_document.value = client.document || '';
    form.elements.customer_email.value = client.email || '';
    form.elements.customer_address.value = client.address || '';
  },

  prefillFiscalOrder(form, orderId) {
    const order = this.state.orders.find((item) => String(item.id) === String(orderId));
    if (!order || !form) return;
    form.elements.service_date.value = order.service_date ? String(order.service_date).slice(0, 10) : (form.elements.service_date.value || '');
    const laborValue = Number(order.labor_price || 0);
    const totalValue = Number(order.total || 0);
    form.elements.service_value.value = laborValue > 0 ? laborValue : (totalValue || '');
    const pieces = [order.services_performed, order.diagnosis, order.complaint].filter(Boolean);
    form.elements.service_description.value = pieces.join(' | ') || form.elements.service_description.value || '';
    if (order.notes) {
      form.elements.notes.value = order.notes;
    }
    if (order.client_id) {
      const select = form.elements.client_id;
      if (select) select.value = String(order.client_id);
      this.prefillFiscalClient(form, order.client_id);
      const filter = form.querySelector('.select-filter-input[data-filter-target="fiscalClientSelect"]');
      if (filter) {
        const selected = select?.selectedOptions?.[0];
        filter.value = selected?.textContent || '';
      }
    }
  },

  fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Falha ao ler o arquivo do certificado.'));
      reader.readAsDataURL(file);
    });
  },

  async copyText(text) {
    if (!text) {
      this.toast('Nada para copiar.', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      this.toast('Texto copiado.');
    } catch (_error) {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      this.toast('Texto copiado.');
    }
  },

  fillForm(form, data = {}) {
    Object.entries(data).forEach(([key, value]) => {
      const field = form.elements[key];
      if (field) field.value = value ?? '';
    });
  },

  formToObject(form) {
    return Object.fromEntries(new FormData(form).entries());
  },

  resetEditing(key) {
    this.state.editing[key] = null;
  },

  normalizeText(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .trim();
  },

  async safeAction(fn) {
    try {
      await fn();
    } catch (error) {
      this.toast(error.message, 'error');
    }
  },

  async safeDelete(path, successMessage) {
    if (!confirm('Confirma a exclusão?')) return;
    await this.safeAction(async () => {
      await this.api(path, { method: 'DELETE' });
      await this.loadAll();
      this.toast(successMessage);
    });
  },

  clientOptions(includeEmpty = false) {
    return `${includeEmpty ? '<option value="">Consumidor / sem cliente</option>' : '<option value="">Selecione</option>'}${this.state.clients.map((item) => `<option value="${item.id}">${this.escape(item.name)}</option>`).join('')}`;
  },

  clientSelectField({ includeEmpty = false, selectId = 'clientSelect' } = {}) {
    return `
      <div class="field">
        <label>Cliente</label>
        <div class="search-select">
          <input
            type="search"
            class="select-filter-input"
            data-filter-target="${selectId}"
            placeholder="Buscar cliente por nome"
            autocomplete="off"
          >
          <select id="${selectId}" name="client_id">${this.clientOptions(includeEmpty)}</select>
        </div>
      </div>
    `;
  },

  motorcycleOptions() {
    return `<option value="">Selecione</option>${this.state.motorcycles.map((item) => `<option value="${item.id}">${this.escape(item.brand)} ${this.escape(item.model)} ${item.plate ? `• ${this.escape(item.plate)}` : ''}</option>`).join('')}`;
  },

  budgetOptions() {
    return `<option value="">Sem vínculo</option>${this.state.budgets.map((item) => `<option value="${item.id}">${this.escape(item.number)} • ${this.escape(item.client_name || 'Sem cliente')}</option>`).join('')}`;
  },

  productOptions() {
    return `<option value="">Item manual</option>${this.state.products.map((item) => `<option value="${item.id}" data-price="${item.price}">${this.escape(item.name)} • ${this.money(item.price)}</option>`).join('')}`;
  },

  appendBudgetItem(container, data = {}) {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.innerHTML = `
      <input name="description" placeholder="Descrição" value="${this.escape(data.description || '')}">
      <input name="quantity" type="number" step="0.01" min="0" placeholder="Qtd" value="${this.escape(data.quantity || 1)}">
      <input name="unit_price" type="number" step="0.01" min="0" placeholder="Valor" value="${this.escape(data.unit_price || '')}">
      <button type="button" class="mini-btn danger remove-row">X</button>
    `;
    row.querySelector('.remove-row').addEventListener('click', () => row.remove());
    container.appendChild(row);
  },

  appendSaleItem(container, data = {}) {
    const row = document.createElement('div');
    row.className = 'item-row sale';
    row.innerHTML = `
      <select name="product_id">${this.productOptions()}</select>
      <input name="description" placeholder="Descrição" value="${this.escape(data.description || '')}">
      <input name="quantity" type="number" step="0.01" min="0" placeholder="Qtd" value="${this.escape(data.quantity || 1)}">
      <input name="unit_price" type="number" step="0.01" min="0" placeholder="Valor" value="${this.escape(data.unit_price || '')}">
      <button type="button" class="mini-btn danger remove-row">X</button>
    `;
    const select = row.querySelector('select[name="product_id"]');
    select.value = data.product_id || '';
    select.addEventListener('change', () => {
      const option = select.selectedOptions[0];
      const product = this.state.products.find((item) => String(item.id) === String(select.value));
      if (product) {
        row.querySelector('input[name="description"]').value = product.name;
        row.querySelector('input[name="unit_price"]').value = product.price;
      }
      if (!select.value) {
        row.querySelector('input[name="description"]').value = '';
      }
    });
    row.querySelector('.remove-row').addEventListener('click', () => row.remove());
    container.appendChild(row);
  },

  collectItems(container, includeProductId) {
    return [...container.querySelectorAll('.item-row')]
      .map((row) => ({
        product_id: includeProductId ? row.querySelector('[name="product_id"]')?.value || '' : '',
        description: row.querySelector('[name="description"]')?.value || '',
        quantity: row.querySelector('[name="quantity"]')?.value || 0,
        unit_price: row.querySelector('[name="unit_price"]')?.value || 0,
      }))
      .filter((item) => item.description.trim());
  },

  today() {
    return new Date().toISOString().slice(0, 10);
  },

  logout() {
    localStorage.removeItem('jg_token');
    localStorage.removeItem('jg_user');
    this.state.token = '';
    this.state.user = null;
    this.renderLogin();
  },
};

window.addEventListener('DOMContentLoaded', () => App.init());

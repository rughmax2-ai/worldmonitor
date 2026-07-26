/**
 * CountryProfilePanel — a simpler, full-screen country profile view.
 *
 * Activated via ?country=XX&profile=1. Presents the most important signals in
 * a clean, scannable layout without the complexity of CountryDeepDivePanel.
 *
 * Sections:
 *   1. Header      — flag, name, CII score badge, close + switch-to-deepdive buttons
 *   2. Key Facts   — capital, population, head of state, currency
 *   3. AI Brief    — prose summary
 *   4. Top Alerts  — up to 5 critical/high threat signals
 *   5. News        — 8 recent headlines
 *   6. Economy     — up to 5 economic indicators
 *   7. Markets     — stock index + top prediction markets
 */

import type { CountryBriefSignals, NewsItem } from '@/types';
import type { CountryScore } from '@/services/country-instability';
import type { PredictionMarket } from '@/services/prediction';
import type {
  CountryBriefPanel,
  CountryIntelData,
  StockIndexData,
  CountryDeepDiveSignalDetails,
  CountryDeepDiveSignalItem,
  CountryDeepDiveMilitarySummary,
  CountryDeepDiveEconomicIndicator,
  CountryFactsData,
  ChinaCountrySummaryData,
  CountryEnergyProfileData,
  CountryPortActivityData,
} from './CountryBriefPanel';
import type {
  GetCountryChokepointIndexResponse,
  SectorExposureSummary,
  CountryProductsResponse,
  MultiSectorShockResponse,
} from '@/services/supply-chain';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { toFlagEmoji } from '@/utils/country-flag';
import { ciiBandForLevel } from './CountryDeepDivePanel-cii';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { formatIntelBrief } from '@/utils/format-intel-brief';
import type { BriefSource } from '@/utils/brief-sources';

type ThreatLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';

const THREAT_LEVEL_LABEL: Record<ThreatLevel, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function toThreatLevel(level: string | undefined): ThreatLevel {
  if (level === 'critical' || level === 'high' || level === 'medium' || level === 'low' || level === 'info') {
    return level;
  }
  return 'low';
}

export class CountryProfilePanel implements CountryBriefPanel {
  readonly isProfileView = true as const;

  private panel: HTMLElement;
  private body: HTMLElement;
  private currentCode: string | null = null;
  private currentName: string | null = null;
  private abortController = new AbortController();
  private onCloseCallback?: () => void;
  private onShareStory?: (code: string, name: string) => void;
  private onExportImage?: (code: string, name: string) => void;
  private onStateChangeCallback?: (state: { visible: boolean; maximized: boolean }) => void;
  private onSwitchToFullView?: (code: string, name: string) => void;

  // Section body slots
  private briefBody: HTMLElement | null = null;
  private factsBody: HTMLElement | null = null;
  private alertsBody: HTMLElement | null = null;
  private newsBody: HTMLElement | null = null;
  private economyBody: HTMLElement | null = null;
  private marketsBody: HTMLElement | null = null;
  private scoreChip: HTMLElement | null = null;
  private headerFlag: HTMLElement | null = null;
  private headerTitle: HTMLElement | null = null;

  private timelineMount: HTMLElement | null = null;

  private readonly handleKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.panel.classList.contains('cpp-active')) {
      e.preventDefault();
      this.hide();
    }
  };

  constructor(opts?: { onSwitchToFullView?: (code: string, name: string) => void }) {
    this.onSwitchToFullView = opts?.onSwitchToFullView;
    this.panel = this.getOrCreatePanel();
    const body = this.panel.querySelector<HTMLElement>('#cpp-body');
    if (!body) throw new Error('CountryProfilePanel structure invalid');
    this.body = body;
  }

  // ─────────────────────────────────────────────────────── CountryBriefPanel API

  public get signal(): AbortSignal {
    return this.abortController.signal;
  }

  public onClose(cb: () => void): void {
    this.onCloseCallback = cb;
  }

  public setShareStoryHandler(handler: (code: string, name: string) => void): void {
    this.onShareStory = handler;
  }

  public setExportImageHandler(handler: (code: string, name: string) => void): void {
    this.onExportImage = handler;
  }

  public onStateChange(cb: (state: { visible: boolean; maximized: boolean }) => void): void {
    this.onStateChangeCallback = cb;
  }

  public getCode(): string | null { return this.currentCode; }
  public getName(): string | null { return this.currentName; }
  public isVisible(): boolean { return this.panel.classList.contains('cpp-active'); }
  public getIsMaximized(): boolean { return true; } // always full-screen
  public getTimelineMount(): HTMLElement | null { return this.timelineMount; }

  public showLoading(): void {
    this.currentCode = '__loading__';
    this.currentName = null;
    this.renderLoading();
    this.open();
  }

  public show(country: string, code: string, _score: CountryScore | null, _signals: CountryBriefSignals): void {
    this.abortController.abort();
    this.abortController = new AbortController();
    this.currentCode = code;
    this.currentName = country;
    this.renderSkeleton(country, code, _score, _signals);
    this.open();
  }

  public hide(): void {
    this.abortController.abort();
    this.panel.classList.remove('cpp-active');
    this.panel.setAttribute('aria-hidden', 'true');
    this.currentCode = null;
    this.currentName = null;
    this.onCloseCallback?.();
    this.onStateChangeCallback?.({ visible: false, maximized: false });
    document.removeEventListener('keydown', this.handleKeydown);
  }

  public maximize(): void { /* already full-screen */ }
  public minimize(): void { this.hide(); }

  public updateBrief(data: CountryIntelData): void {
    if (!this.briefBody) return;
    if (data.error && !data.brief) {
      this.briefBody.textContent = 'Brief unavailable.';
      return;
    }
    if (!data.brief) return;
    const sources: BriefSource[] = data.sources ?? [];
    const html = formatIntelBrief(data.brief, sources.length > 0 ? { sources } : undefined);
    setTrustedHtml(this.briefBody, trustedHtml(html, 'legacy direct innerHTML migration'));
  }

  public updateNews(headlines: NewsItem[]): void {
    if (!this.newsBody) return;
    this.newsBody.replaceChildren();
    const items = headlines.slice(0, 8);
    if (items.length === 0) {
      this.newsBody.textContent = 'No recent headlines.';
      return;
    }
    const list = this.el('ul', 'cpp-news-list');
    for (const item of items) {
      const li = this.el('li', 'cpp-news-item');
      const level = toThreatLevel(item.threat?.level);
      const a = this.el('a', 'cpp-news-link') as HTMLAnchorElement;
      a.href = sanitizeUrl(item.link ?? '');
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      const badge = this.el('span', `cpp-severity cpp-severity-${level}`, THREAT_LEVEL_LABEL[level]);
      const title = this.el('span', 'cpp-news-title', decodeEntities(item.title));
      a.append(badge, title);
      li.append(a);
      list.append(li);
    }
    this.newsBody.append(list);
  }

  public updateMarkets(markets: PredictionMarket[]): void {
    if (!this.marketsBody) return;
    const existing = this.marketsBody.querySelector<HTMLElement>('.cpp-markets-predictions');
    if (existing) existing.remove();
    if (markets.length === 0) return;
    const top = markets.slice(0, 3);
    const wrap = this.el('div', 'cpp-markets-predictions');
    for (const m of top) {
      const row = this.el('div', 'cpp-market-row');
      const q = this.el('span', 'cpp-market-question', decodeEntities(m.question));
      const pct = typeof m.probability === 'number' ? `${Math.round(m.probability * 100)}%` : '—';
      const p = this.el('span', 'cpp-market-prob', pct);
      row.append(q, p);
      wrap.append(row);
    }
    this.marketsBody.append(wrap);
  }

  public updateStock(data: StockIndexData): void {
    if (!this.marketsBody) return;
    const existing = this.marketsBody.querySelector<HTMLElement>('.cpp-stock-row');
    if (existing) existing.remove();
    if (!data.available) return;
    const row = this.el('div', 'cpp-stock-row');
    const label = this.el('span', 'cpp-stock-label', `${data.indexName} (${data.symbol})`);
    const price = this.el('span', 'cpp-stock-price', data.price);
    const trend = parseFloat(data.weekChangePercent);
    const trendClass = Number.isFinite(trend) ? (trend >= 0 ? 'cpp-trend-up' : 'cpp-trend-down') : '';
    const trendEl = this.el('span', `cpp-stock-change ${trendClass}`.trim(), data.weekChangePercent);
    row.append(label, price, trendEl);
    this.marketsBody.prepend(row);
  }

  public updateInfrastructure(_code: string): void {
    // Infrastructure is omitted from the profile view for simplicity.
  }

  public updateScore(score: CountryScore | null, _signals: CountryBriefSignals): void {
    if (!this.scoreChip || !score) return;
    const band = ciiBandForLevel(score.level);
    this.scoreChip.className = `cpp-score-chip cii-${band}`;
    this.scoreChip.textContent = `CII ${score.score}/100`;
  }

  public updateSignalDetails(details: CountryDeepDiveSignalDetails): void {
    if (!this.alertsBody) return;
    this.alertsBody.replaceChildren();
    const items = details.recentHigh.slice(0, 5);
    if (items.length === 0) {
      this.alertsBody.textContent = 'No active high-severity signals.';
      return;
    }
    const list = this.el('ul', 'cpp-alerts-list');
    for (const item of items) {
      const level = toThreatLevel(item.severity);
      const li = this.el('li', 'cpp-alert-row');
      const badge = this.el('span', `cpp-severity cpp-severity-${level}`, THREAT_LEVEL_LABEL[level]);
      const desc = this.el('span', 'cpp-alert-desc', item.description);
      li.append(badge, desc);
      list.append(li);
    }
    this.alertsBody.append(list);
  }

  public updateMilitaryActivity(_summary: CountryDeepDiveMilitarySummary): void {
    // Omitted from profile view.
  }

  public updateEconomicIndicators(indicators: CountryDeepDiveEconomicIndicator[]): void {
    if (!this.economyBody) return;
    this.economyBody.replaceChildren();
    const items = indicators.slice(0, 5);
    if (items.length === 0) return;
    const grid = this.el('div', 'cpp-economy-grid');
    for (const ind of items) {
      const card = this.el('div', 'cpp-economy-card');
      const label = this.el('div', 'cpp-economy-label', ind.label);
      const trendIcon = ind.trend === 'up' ? '↑' : ind.trend === 'down' ? '↓' : '→';
      const trendClass = ind.trend === 'up' ? 'cpp-trend-up' : ind.trend === 'down' ? 'cpp-trend-down' : '';
      const val = this.el('div', `cpp-economy-value ${trendClass}`.trim(), `${ind.value} ${trendIcon}`);
      card.append(label, val);
      grid.append(card);
    }
    this.economyBody.append(grid);
  }

  public updateCountryFacts(data: CountryFactsData): void {
    if (!this.factsBody) return;
    this.factsBody.replaceChildren();
    const facts: Array<[string, string]> = [];
    if (data.capital) facts.push(['Capital', escapeHtml(data.capital)]);
    if (data.population > 0) facts.push(['Population', formatNumber(data.population)]);
    if (data.headOfState && data.headOfStateTitle) {
      facts.push([escapeHtml(data.headOfStateTitle), escapeHtml(data.headOfState)]);
    }
    if (data.languages.length > 0) facts.push(['Language', escapeHtml(data.languages.slice(0, 2).join(', '))]);
    if (data.currencies.length > 0) facts.push(['Currency', escapeHtml(data.currencies.slice(0, 2).join(', '))]);
    const grid = this.el('div', 'cpp-facts-grid');
    for (const [k, v] of facts) {
      const item = this.el('div', 'cpp-fact-item');
      const lbl = this.el('span', 'cpp-fact-label');
      lbl.textContent = k;
      const val = this.el('span', 'cpp-fact-value');
      val.textContent = v;
      item.append(lbl, val);
      grid.append(item);
    }
    this.factsBody.append(grid);
  }

  // Unused optional methods — satisfy the interface

  public updateChinaCountrySummary(_data: ChinaCountrySummaryData): void { /* omitted */ }
  public updateEnergyProfile(_data: CountryEnergyProfileData): void { /* omitted */ }
  public updateMaritimeActivity(_data: CountryPortActivityData): void { /* omitted */ }
  public updateTradeExposure(_data: GetCountryChokepointIndexResponse | null, _sectors?: SectorExposureSummary[]): void { /* omitted */ }
  public updateNationalDebt(_entry: { debtToGdp: number; debtUsd: number; annualGrowth: number; source: string } | null): void { /* omitted */ }
  public updateSanctionsPressure(_data: { entryCount: number; sanctionsActive?: boolean } | null): void { /* omitted */ }
  public updateComtradeFlows(_flows: Array<{ partnerName: string; cmdDesc: string; tradeValueUsd: number; yoyChange: number }> | null): void { /* omitted */ }
  public updateTariffTrends(_data: { currentRate: number; trend: string; datapoints: Array<{ year: number; tariffRate: number }> } | null): void { /* omitted */ }
  public updateMultiSectorCostShock(_data: MultiSectorShockResponse | null): void { /* omitted */ }
  public updateProductImports(_data: CountryProductsResponse | null): void { /* omitted */ }
  public updateHousingCycle(_data: {
    residential?: { indexValue: number; qoqChange: number | null; yoyChange: number | null; period: string } | null;
    commercial?: { indexValue: number; qoqChange: number | null; yoyChange: number | null; period: string } | null;
    dsr?: { dsrPct: number; change: number | null; period: string } | null;
  } | null): void { /* omitted */ }

  // ─────────────────────────────────────────────────────── Internal rendering

  private renderLoading(): void {
    this.clearBody();
    const wrap = this.el('div', 'cpp-loading');
    wrap.append(
      this.el('div', 'cpp-loading-bar'),
      this.el('div', 'cpp-loading-bar cpp-loading-bar-short'),
      this.el('p', 'cpp-loading-text', 'Identifying location…'),
    );
    this.body.append(wrap);
  }

  private renderSkeleton(country: string, code: string, score: CountryScore | null, _signals: CountryBriefSignals): void {
    this.clearBody();

    // ── Header ────────────────────────────────────────────────────────────────
    const header = this.el('header', 'cpp-header');

    const left = this.el('div', 'cpp-header-left');
    const flag = this.el('span', 'cpp-flag', toFlagEmoji(code, '🌍'));
    this.headerFlag = flag;
    const titleWrap = this.el('div', 'cpp-title-wrap');
    const title = this.el('h2', 'cpp-country-name', country);
    this.headerTitle = title;
    const sub = this.el('div', 'cpp-country-sub', `${code.toUpperCase()} · Country Profile`);
    titleWrap.append(title, sub);

    const scoreChip = this.el('span', 'cpp-score-chip');
    this.scoreChip = scoreChip;
    if (score) {
      const band = ciiBandForLevel(score.level);
      scoreChip.className = `cpp-score-chip cii-${band}`;
      scoreChip.textContent = `CII ${score.score}/100`;
    } else {
      scoreChip.textContent = 'CII —';
    }

    left.append(flag, titleWrap, scoreChip);

    const right = this.el('div', 'cpp-header-right');

    if (this.onSwitchToFullView) {
      const switchBtn = this.el('button', 'cpp-action-btn cpp-switch-btn', 'Full Deep-Dive') as HTMLButtonElement;
      switchBtn.setAttribute('type', 'button');
      switchBtn.setAttribute('title', 'Open full Country Deep-Dive panel');
      switchBtn.addEventListener('click', () => {
        if (this.currentCode && this.currentName && this.onSwitchToFullView) {
          this.onSwitchToFullView(this.currentCode, this.currentName);
        }
      });
      right.append(switchBtn);
    }

    const closeBtn = this.el('button', 'cpp-close-btn', '×') as HTMLButtonElement;
    closeBtn.setAttribute('type', 'button');
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', () => this.hide());
    right.append(closeBtn);

    header.append(left, right);

    // ── Sections ──────────────────────────────────────────────────────────────
    const [factsSection, factsBody] = this.section('Key Facts', 'cpp-facts');
    this.factsBody = factsBody;
    factsBody.textContent = 'Loading…';

    const [briefSection, briefBody] = this.section('Intelligence Brief', 'cpp-brief');
    this.briefBody = briefBody;
    briefBody.textContent = 'Generating brief…';

    const [alertsSection, alertsBody] = this.section('Active Alerts', 'cpp-alerts');
    this.alertsBody = alertsBody;
    alertsBody.textContent = 'Loading signals…';

    const [newsSection, newsBody] = this.section('Recent Headlines', 'cpp-news');
    this.newsBody = newsBody;
    newsBody.textContent = 'Loading headlines…';

    const [economySection, economyBody] = this.section('Economic Snapshot', 'cpp-economy');
    this.economyBody = economyBody;
    economyBody.textContent = 'Loading indicators…';

    const [marketsSection, marketsBody] = this.section('Markets', 'cpp-markets');
    this.marketsBody = marketsBody;
    marketsBody.textContent = 'Loading market data…';

    // Timeline mount (unused by this panel but satisfies interface)
    const tlMount = this.el('div', 'cpp-timeline-mount');
    tlMount.hidden = true;
    this.timelineMount = tlMount;

    this.body.append(
      header,
      factsSection,
      briefSection,
      alertsSection,
      newsSection,
      economySection,
      marketsSection,
      tlMount,
    );
  }

  private open(): void {
    this.panel.classList.add('cpp-active');
    this.panel.removeAttribute('aria-hidden');
    this.onStateChangeCallback?.({ visible: true, maximized: true });
    document.addEventListener('keydown', this.handleKeydown);
  }

  private clearBody(): void {
    this.body.replaceChildren();
    this.briefBody = null;
    this.factsBody = null;
    this.alertsBody = null;
    this.newsBody = null;
    this.economyBody = null;
    this.marketsBody = null;
    this.scoreChip = null;
    this.headerFlag = null;
    this.headerTitle = null;
    this.timelineMount = null;
  }

  private section(title: string, bodyClass: string): [HTMLElement, HTMLElement] {
    const sec = this.el('section', 'cpp-section');
    const h = this.el('h3', 'cpp-section-title', title);
    const body = this.el('div', bodyClass);
    sec.append(h, body);
    return [sec, body];
  }

  private el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  private getOrCreatePanel(): HTMLElement {
    const existing = document.getElementById('country-profile-panel');
    if (existing) return existing;

    const panel = this.el('aside', 'country-profile-panel');
    panel.id = 'country-profile-panel';
    panel.setAttribute('aria-label', 'Country Profile');
    panel.setAttribute('aria-hidden', 'true');
    panel.setAttribute('role', 'dialog');

    const body = this.el('div', 'cpp-body');
    body.id = 'cpp-body';
    panel.append(body);

    document.body.append(panel);
    return panel;
  }
}

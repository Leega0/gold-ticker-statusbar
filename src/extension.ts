import * as vscode from 'vscode';

const REFRESH_COMMAND = 'goldTicker.refreshNow';
const OUNCES_TO_GRAMS = 31.1034768;
const SINA_HQ_BASE_URL = 'https://hq.sinajs.cn/list=';
const SINA_REFERER = 'https://finance.sina.com.cn';
const SINA_LONDON_GOLD_CODE = 'hf_XAU';
const SINA_USD_CNY_CODE = 'USDCNY';
const JD_GOLD_PAGE_URL = 'https://btfront.jd.com/release/goldpc/?app=1&version=1.0.26&channel=mas';
const JD_GOLD_QUOTE_URL = 'https://ms.jr.jd.com/gw2/generic/CreatorSer/h5/m/pcQueryGoldQuote';
const JD_GOLD_PRODUCT_URL = 'https://ms.jr.jd.com/gw2/generic/CreatorSer/h5/m/pcQueryGoldProduct';
const JD_LONDON_GOLD_CODE = 'WG-XAUUSD';
const JD_CHINA_GOLD_CODE = 'SGE-Au99.99';
const JD_USD_CNH_CODE = 'FX-USDCNH';
const SGE_DELAYED_QUOTE_URL = 'https://www.sge.com.cn/h5_sjzx/yshq';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const SNAPSHOT_STORAGE_KEY = 'goldTicker.snapshots';
const JIJINHAO_API_URL = 'https://api.jijinhao.com/realtime/quotejs.htm';
const JIJINHAO_REFERER = 'https://gold.cngold.org';
const JIJINHAO_CODE_AU9999 = 'JO_71';
const JIJINHAO_CODE_XAU = 'JO_92233';

type Trend = 'up' | 'down' | 'flat' | 'loading' | 'error';
type ChinaSource = 'jdBank' | 'jdSnapshot' | 'jijinhao' | 'proxy' | 'sgeDelayed';
type JdBankType = 'minsheng' | 'zheshang';

interface SinaRawQuote {
	code: string;
	fields: string[];
}

interface InternationalSnapshot {
	price: number;
	open?: number;
	high?: number;
	low?: number;
	change: number;
	sourceUpdatedAt: string;
	fetchedAt: string;
	sourceLabel?: string;
	sourceDescription?: string;
	sourceUrl?: string;
	quoteCode?: string;
}

interface FxSnapshot {
	rate: number;
	sourceUpdatedAt: string;
	fetchedAt: string;
}

interface ChinaSnapshot {
	sourceKind: ChinaSource;
	symbol: string;
	price: number;
	open?: number;
	high?: number;
	low?: number;
	change: number;
	sourceUpdatedAt: string;
	fetchedAt: string;
	fxRate?: number;
	goldUpdatedAt?: string;
	fxUpdatedAt?: string;
	sourceDescription: string;
	sourceLabel?: string;
	sourceUrl?: string;
	quoteCode?: string;
}

interface SgeRow {
	symbol: string;
	price: number;
	high: number;
	low: number;
	open: number;
}

interface JijinhaoQuote {
	code: string;
	name: string;
	price: number;
	previousClose: number;
	open: number;
	high: number;
	low: number;
	updatedAt: string;
	change: number;
}

interface JdGoldQuoteResponse {
	resultCode?: number;
	resultMsg?: string;
	resultData?: {
		msg?: string;
		systime?: number;
		data?: {
			goldQuoteVos?: Array<{
				uniqueCode?: string;
				name?: string;
				lastPrice?: number;
				lastPriceText?: string;
				raiseText?: string;
				raisePercent100?: string;
				rateValueColor?: string;
			}>;
		};
	};
}

interface JdGoldQuote {
	uniqueCode: string;
	name: string;
	lastPrice: number;
	lastPriceText: string;
	raiseText: string;
	raisePercent100: string;
	rateValueColor: string;
}

interface JdGoldQuoteSnapshot {
	quotes: Record<string, JdGoldQuote>;
	sourceUpdatedAt: string;
	fetchedAt: string;
}

interface JdGoldProductResponse {
	resultCode?: number;
	resultMsg?: string;
	resultData?: {
		msg?: string;
		systime?: number;
		code?: number;
		data?: {
			rateValueColor?: string;
			productId?: string;
			goldName?: string;
			raise?: string;
			priceValue?: string | number;
			raisePercent100?: string;
			skuType?: string;
			goldChartDataVOS?: Array<{
				name?: string;
				value?: string[];
			}>;
		};
	};
}

interface JdGoldProductPoint {
	time: string;
	price: number;
}

interface JdGoldProductSnapshot {
	productId: string;
	goldName: string;
	price: number;
	change: number;
	changePercent: string;
	points: JdGoldProductPoint[];
	sourceUpdatedAt: string;
	fetchedAt: string;
}

interface GoldTickerConfig {
	refreshIntervalMs: number;
	showInternational: boolean;
	showChina: boolean;
	alignment: vscode.StatusBarAlignment;
	internationalLabel: string;
	chinaLabel: string;
	chinaSource: ChinaSource;
	chinaBank: JdBankType;
	chinaSymbol: string;
	showDelta: boolean;
	usdPrecision: number;
	cnyPrecision: number;
	deltaPrecision: number;
	upColor: string;
	downColor: string;
	flatColor: string;
	loadingColor: string;
	errorColor: string;
}

function getJdBankMeta(bankType: JdBankType): {
	goldType: '1' | '2';
	label: string;
	goldName: string;
	quoteCode: string;
} {
	return bankType === 'zheshang'
		? {
			goldType: '2',
			label: '浙商金',
			goldName: '浙商金价',
			quoteCode: '浙商金 / goldType=2'
		}
		: {
			goldType: '1',
			label: '民生金',
			goldName: '民生金价',
			quoteCode: '民生金 / goldType=1'
		};
}

class GoldTickerController implements vscode.Disposable {
	private config = readConfig();
	private internationalItem?: vscode.StatusBarItem;
	private chinaItem?: vscode.StatusBarItem;
	private timer?: NodeJS.Timeout;
	private isRefreshing = false;
	private lastInternational?: InternationalSnapshot;
	private lastChina?: ChinaSnapshot;
	private previousInternationalPrice?: number;
	private previousChinaPrice?: number;
	private lastInternationalError?: string;
	private lastChinaError?: string;
	private errorCount = 0;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly context: vscode.ExtensionContext) {
		this.restoreSnapshots();

		this.disposables.push(
			vscode.commands.registerCommand(REFRESH_COMMAND, async () => {
				await this.refresh();
			}),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (!event.affectsConfiguration('goldTicker')) {
					return;
				}

				const previousConfig = this.config;
				this.config = readConfig();

				if (
					previousConfig.chinaSource !== this.config.chinaSource ||
					previousConfig.chinaSymbol !== this.config.chinaSymbol
				) {
					this.lastChina = undefined;
					this.previousChinaPrice = undefined;
					this.lastChinaError = undefined;
					void this.persistSnapshots();
				}

				this.rebuildStatusBarItems();
				void this.refresh();
			})
		);

		this.rebuildStatusBarItems();
		void this.refresh();
	}

	public dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}

		this.internationalItem?.dispose();
		this.chinaItem?.dispose();
		vscode.Disposable.from(...this.disposables).dispose();
	}

	private rebuildStatusBarItems(): void {
		this.internationalItem?.dispose();
		this.chinaItem?.dispose();

		this.internationalItem = vscode.window.createStatusBarItem(this.config.alignment, 200);
		this.internationalItem.command = REFRESH_COMMAND;
		this.internationalItem.name = 'Gold Ticker International';

		this.chinaItem = vscode.window.createStatusBarItem(this.config.alignment, 199);
		this.chinaItem.command = REFRESH_COMMAND;
		this.chinaItem.name = 'Gold Ticker China';

		this.renderCurrentState();
	}

	private async refresh(): Promise<void> {
		if (this.isRefreshing) {
			return;
		}

		if (!this.config.showInternational && !this.config.showChina) {
			this.internationalItem?.hide();
			this.chinaItem?.hide();
			return;
		}

		this.isRefreshing = true;
		const refreshStartedAt = Date.now();

		if (!this.lastInternational && !this.lastChina && !this.lastInternationalError && !this.lastChinaError) {
			this.renderLoading();
		}

		try {
			const useJdBank = this.config.chinaSource === 'jdBank';
			const useJdChina = this.config.chinaSource === 'jdSnapshot';
			const useJijinhao = this.config.chinaSource === 'jijinhao';
			const useProxy = this.config.chinaSource === 'proxy';
			const useSge = this.config.chinaSource === 'sgeDelayed';

			const [jdQuoteResult, jdBankResult, jijinhaoChinaResult, sinaProxyResult, sgeResult] = await Promise.allSettled([
				this.config.showInternational || (this.config.showChina && (useJdChina || useProxy))
					? fetchJdGoldQuoteSnapshot()
					: Promise.resolve(undefined),
				this.config.showChina && useJdBank
					? fetchJdGoldProductSnapshot(this.config.chinaBank)
					: Promise.resolve(undefined),
				this.config.showChina && useJijinhao
					? fetchJijinhaoQuotes([JIJINHAO_CODE_AU9999])
					: Promise.resolve(undefined),
				this.config.showChina && useProxy
					? fetchSinaQuotes([SINA_LONDON_GOLD_CODE, SINA_USD_CNY_CODE])
					: Promise.resolve(undefined),
				this.config.showChina && useSge
					? fetchSgeChinaSnapshot(this.config.chinaSymbol)
					: Promise.resolve(undefined)
			]);

			let anySuccess = false;
			let anyAttempt = false;
			let internationalSnapshot: InternationalSnapshot | undefined;

			// === 国际金价 ===
			if (this.config.showInternational) {
				anyAttempt = true;

				if (jdQuoteResult.status === 'fulfilled' && jdQuoteResult.value) {
					try {
						internationalSnapshot = parseJdInternationalSnapshot(jdQuoteResult.value);
					} catch (error) {
						this.lastInternationalError = toErrorMessage(error);
					}
				}

				if (!internationalSnapshot && sinaProxyResult.status === 'fulfilled' && sinaProxyResult.value) {
					try {
						internationalSnapshot = parseLondonGoldSnapshot(sinaProxyResult.value);
					} catch (error) {
						this.lastInternationalError = toErrorMessage(error);
					}
				}

				if (!internationalSnapshot) {
					try {
						const jijinhaoFallback = await fetchJijinhaoQuotes([JIJINHAO_CODE_XAU]);
						internationalSnapshot = parseJijinhaoInternational(jijinhaoFallback);
					} catch (error) {
						this.lastInternationalError = toErrorMessage(error);
					}
				}

				if (!internationalSnapshot && !useProxy) {
					try {
						const sinaFallback = await fetchSinaQuotes([SINA_LONDON_GOLD_CODE]);
						internationalSnapshot = parseLondonGoldSnapshot(sinaFallback);
					} catch (error) {
						this.lastInternationalError = toErrorMessage(error);
					}
				}

				if (internationalSnapshot) {
					anySuccess = true;
					this.lastInternationalError = undefined;
					this.renderInternational(internationalSnapshot);
					this.previousInternationalPrice = internationalSnapshot.price;
					this.lastInternational = internationalSnapshot;
					void this.persistSnapshots();
				} else {
					this.renderInternationalError(this.lastInternationalError ?? '国际金价数据获取失败');
				}
			}

			// === 中国金价 ===
			if (this.config.showChina) {
				anyAttempt = true;

				if (useJdBank) {
					if (jdBankResult.status === 'fulfilled' && jdBankResult.value) {
						try {
							const chinaSnapshot = parseJdBankSnapshot(jdBankResult.value, this.config.chinaBank);
							anySuccess = true;
							this.lastChinaError = undefined;
							this.renderChina(chinaSnapshot);
							this.previousChinaPrice = chinaSnapshot.price;
							this.lastChina = chinaSnapshot;
							void this.persistSnapshots();
						} catch (error) {
							this.lastChinaError = toErrorMessage(error);
							this.renderChinaError(this.lastChinaError);
						}
					} else {
						this.lastChinaError = toSettledErrorMessage(jdBankResult);
						this.renderChinaError(this.lastChinaError);
					}
				} else if (useJdChina) {
					if (jdQuoteResult.status === 'fulfilled' && jdQuoteResult.value) {
						try {
							const chinaSnapshot = parseJdChinaSnapshot(jdQuoteResult.value);
							anySuccess = true;
							this.lastChinaError = undefined;
							this.renderChina(chinaSnapshot);
							this.previousChinaPrice = chinaSnapshot.price;
							this.lastChina = chinaSnapshot;
							void this.persistSnapshots();
						} catch (error) {
							this.lastChinaError = toErrorMessage(error);
							this.renderChinaError(this.lastChinaError);
						}
					} else {
						this.lastChinaError = toSettledErrorMessage(jdQuoteResult);
						this.renderChinaError(this.lastChinaError);
					}
				} else if (useJijinhao) {
					if (jijinhaoChinaResult.status === 'fulfilled' && jijinhaoChinaResult.value) {
						try {
							const chinaSnapshot = parseJijinaoChinaSnapshot(jijinhaoChinaResult.value);
							anySuccess = true;
							this.lastChinaError = undefined;
							this.renderChina(chinaSnapshot);
							this.previousChinaPrice = chinaSnapshot.price;
							this.lastChina = chinaSnapshot;
							void this.persistSnapshots();
						} catch (error) {
							this.lastChinaError = toErrorMessage(error);
							this.renderChinaError(this.lastChinaError);
						}
					} else {
						this.lastChinaError = toSettledErrorMessage(jijinhaoChinaResult);
						this.renderChinaError(this.lastChinaError);
					}
				} else if (useProxy) {
					try {
						let fxSnapshot: FxSnapshot | undefined;
						let londonSnapshot = internationalSnapshot;

						if (jdQuoteResult.status === 'fulfilled' && jdQuoteResult.value) {
							fxSnapshot = parseJdUsdCnhSnapshot(jdQuoteResult.value);
							londonSnapshot = londonSnapshot ?? parseJdInternationalSnapshot(jdQuoteResult.value);
						}

						if ((!fxSnapshot || !londonSnapshot) && sinaProxyResult.status === 'fulfilled' && sinaProxyResult.value) {
							fxSnapshot = fxSnapshot ?? parseUsdCnySnapshot(sinaProxyResult.value);
							londonSnapshot = londonSnapshot ?? parseLondonGoldSnapshot(sinaProxyResult.value);
						}

						if (!fxSnapshot || !londonSnapshot) {
							throw new Error('未获取到可用于人民币金换算的伦敦金或汇率数据');
						}

						const chinaSnapshot = buildProxyChinaSnapshot(londonSnapshot, fxSnapshot);
						anySuccess = true;
						this.lastChinaError = undefined;
						this.renderChina(chinaSnapshot);
						this.previousChinaPrice = chinaSnapshot.price;
						this.lastChina = chinaSnapshot;
						void this.persistSnapshots();
					} catch (error) {
						this.lastChinaError = toErrorMessage(error);
						this.renderChinaError(this.lastChinaError);
					}
				} else {
					if (sgeResult.status === 'fulfilled' && sgeResult.value) {
						anySuccess = true;
						this.lastChinaError = undefined;
						this.renderChina(sgeResult.value);
						this.previousChinaPrice = sgeResult.value.price;
						this.lastChina = sgeResult.value;
						void this.persistSnapshots();
					} else {
						this.lastChinaError = toSettledErrorMessage(sgeResult);
						this.renderChinaError(this.lastChinaError);
					}
				}
			}

			this.errorCount = anySuccess ? 0 : (anyAttempt ? this.errorCount + 1 : 0);
		} finally {
			this.isRefreshing = false;
			this.scheduleNextRefresh(refreshStartedAt);
		}
	}

	private renderCurrentState(): void {
		if (this.config.showInternational) {
			if (this.lastInternational) {
				this.renderInternational(this.lastInternational);
			} else if (this.lastInternationalError) {
				this.renderInternationalError(this.lastInternationalError);
			} else {
				this.renderInternationalLoading();
			}
		} else {
			this.internationalItem?.hide();
		}

		if (this.config.showChina) {
			if (this.lastChina) {
				this.renderChina(this.lastChina);
			} else if (this.lastChinaError) {
				this.renderChinaError(this.lastChinaError);
			} else {
				this.renderChinaLoading();
			}
		} else {
			this.chinaItem?.hide();
		}
	}

	private renderLoading(): void {
		this.renderInternationalLoading();
		this.renderChinaLoading();
	}

	private renderInternationalLoading(): void {
		if (!this.config.showInternational || !this.internationalItem) {
			this.internationalItem?.hide();
			return;
		}

		this.internationalItem.text = `$(sync~spin) ${this.config.internationalLabel} --`;
		this.internationalItem.color = this.colorForTrend('loading');
		this.internationalItem.tooltip = '正在刷新伦敦金，默认优先使用京东黄金盯盘快照，点击可立即刷新。';
		this.internationalItem.show();
	}

	private renderChinaLoading(): void {
		if (!this.config.showChina || !this.chinaItem) {
			this.chinaItem?.hide();
			return;
		}

		const bankLabel = getJdBankMeta(this.config.chinaBank).label;
		const sourceText = this.config.chinaSource === 'jdSnapshot'
			? 'Au99.99'
			: this.config.chinaSource === 'jdBank'
			? bankLabel
			: this.config.chinaSource === 'jijinhao'
			? 'Au99.99'
			: this.config.chinaSource === 'proxy'
				? '实时人民币金'
				: `上金所 ${this.config.chinaSymbol}`;

		this.chinaItem.text = `$(sync~spin) ${this.config.chinaLabel} ${sourceText} --`;
		this.chinaItem.color = this.colorForTrend('loading');
		const tooltipMap: Record<ChinaSource, string> = {
			jdBank: `正在拉取京东黄金盯盘页的 ${bankLabel}，点击可立即刷新。`,
			jdSnapshot: '正在拉取京东黄金盯盘页的 Au99.99 快照，点击可立即刷新。',
			jijinhao: '正在拉取集金号 Au99.99 实时行情，点击可立即刷新。',
			proxy: '正在用伦敦金和美元人民币换算实时人民币金，点击可立即刷新。',
			sgeDelayed: '正在拉取上金所延时行情，点击可立即刷新。'
		};
		this.chinaItem.tooltip = tooltipMap[this.config.chinaSource];
		this.chinaItem.show();
	}

	private renderInternational(snapshot: InternationalSnapshot): void {
		if (!this.config.showInternational || !this.internationalItem) {
			this.internationalItem?.hide();
			return;
		}

		const delta = this.previousInternationalPrice === undefined ? 0 : snapshot.price - this.previousInternationalPrice;
		const trend = getTrendFromChange(snapshot.change);
		const relativeDeltaText = this.previousInternationalPrice === undefined
			? '--'
			: formatSignedNumber(delta, this.config.deltaPrecision);
		const tooltipLines = [
			'**国际金价**',
			`口径: \`${snapshot.quoteCode ?? '伦敦金 / XAUUSD'}\``,
			`最新价: \`$${formatNumber(snapshot.price, this.config.usdPrecision)} / oz\``,
			`相对上次刷新: \`${relativeDeltaText}\``,
			`源站涨跌: \`${formatSignedNumber(snapshot.change, this.config.deltaPrecision)}\``,
			isFiniteNumber(snapshot.open)
				? `今开: \`$${formatNumber(snapshot.open, this.config.usdPrecision)} / oz\``
				: undefined,
			isFiniteNumber(snapshot.high)
				? `最高: \`$${formatNumber(snapshot.high, this.config.usdPrecision)} / oz\``
				: undefined,
			isFiniteNumber(snapshot.low)
				? `最低: \`$${formatNumber(snapshot.low, this.config.usdPrecision)} / oz\``
				: undefined,
			`源站时间: \`${formatTimestamp(snapshot.sourceUpdatedAt)}\``,
			`最近抓取: \`${formatTimestamp(snapshot.fetchedAt)}\``,
			snapshot.sourceDescription ? `说明: ${snapshot.sourceDescription}` : undefined,
			snapshot.sourceUrl
				? `来源: [${snapshot.sourceLabel ?? '行情源'}](${snapshot.sourceUrl})`
				: `来源: ${snapshot.sourceLabel ?? '未标记来源'}`,
			'点击状态栏可立即刷新。'
		].filter((line): line is string => Boolean(line));

		this.internationalItem.text = [
			'$(graph-line)',
			this.config.internationalLabel,
			`$${formatNumber(snapshot.price, this.config.usdPrecision)}`,
			formatDelta(snapshot.change, trend, this.config.showDelta, true, this.config.deltaPrecision)
		].filter(Boolean).join(' ');
		this.internationalItem.color = this.colorForTrend(trend);
		this.internationalItem.tooltip = new vscode.MarkdownString(tooltipLines.join('\n\n'));
		this.internationalItem.show();
	}

	private renderChina(snapshot: ChinaSnapshot): void {
		if (!this.config.showChina || !this.chinaItem) {
			this.chinaItem?.hide();
			return;
		}

		const delta = this.previousChinaPrice === undefined ? 0 : snapshot.price - this.previousChinaPrice;
		const trend = snapshot.sourceKind === 'sgeDelayed'
			? getTrend(delta, this.previousChinaPrice)
			: getTrendFromChange(snapshot.change);
		const symbolPart = snapshot.sourceKind === 'proxy' || snapshot.sourceKind === 'jijinhao' || snapshot.sourceKind === 'jdSnapshot' || snapshot.sourceKind === 'jdBank' ? '' : snapshot.symbol;
		const relativeDeltaText = this.previousChinaPrice === undefined
			? '--'
			: formatSignedNumber(delta, this.config.deltaPrecision);

		this.chinaItem.text = [
			'$(pulse)',
			this.config.chinaLabel,
			symbolPart,
			`¥${formatNumber(snapshot.price, this.config.cnyPrecision)}`,
			snapshot.sourceKind === 'sgeDelayed'
				? formatDelta(delta, trend, this.config.showDelta, this.previousChinaPrice !== undefined, this.config.deltaPrecision)
				: formatDelta(snapshot.change, trend, this.config.showDelta, true, this.config.deltaPrecision)
		].filter(Boolean).join(' ');
		this.chinaItem.color = this.colorForTrend(trend);
		let tooltipLines: string[];
		if (snapshot.sourceKind === 'jdBank') {
			tooltipLines = [
				'**中国金价**',
				'模式: `京东银行金价`',
				`品种: \`${snapshot.quoteCode ?? snapshot.symbol}\``,
				`最新价: \`¥${formatNumber(snapshot.price, this.config.cnyPrecision)} / g\``,
				`相对上次刷新: \`${relativeDeltaText}\``,
				`源站涨跌: \`${formatSignedNumber(snapshot.change, this.config.deltaPrecision)}\``,
				isFiniteNumber(snapshot.open)
					? `日内起点: \`¥${formatNumber(snapshot.open, this.config.cnyPrecision)} / g\``
					: undefined,
				isFiniteNumber(snapshot.high)
					? `日内最高: \`¥${formatNumber(snapshot.high, this.config.cnyPrecision)} / g\``
					: undefined,
				isFiniteNumber(snapshot.low)
					? `日内最低: \`¥${formatNumber(snapshot.low, this.config.cnyPrecision)} / g\``
					: undefined,
				`曲线时间: \`${formatTimestamp(snapshot.sourceUpdatedAt)}\``,
				`最近抓取: \`${formatTimestamp(snapshot.fetchedAt)}\``,
				`说明: ${snapshot.sourceDescription}`,
				`来源: [${snapshot.sourceLabel ?? '京东黄金盯盘页'}](${snapshot.sourceUrl ?? JD_GOLD_PAGE_URL})`,
				'点击状态栏可立即刷新。'
			].filter((line): line is string => Boolean(line));
		} else if (snapshot.sourceKind === 'jdSnapshot') {
			tooltipLines = [
				'**中国金价**',
				'模式: `京东黄金盯盘 Au99.99 快照`',
				`合约: \`${snapshot.quoteCode ?? snapshot.symbol}\``,
				`最新价: \`¥${formatNumber(snapshot.price, this.config.cnyPrecision)} / g\``,
				`相对上次刷新: \`${relativeDeltaText}\``,
				`源站涨跌: \`${formatSignedNumber(snapshot.change, this.config.deltaPrecision)}\``,
				`数据时间: \`${formatTimestamp(snapshot.sourceUpdatedAt)}\``,
				`最近抓取: \`${formatTimestamp(snapshot.fetchedAt)}\``,
				`说明: ${snapshot.sourceDescription}`,
				`来源: [${snapshot.sourceLabel ?? '京东黄金盯盘页'}](${snapshot.sourceUrl ?? JD_GOLD_PAGE_URL})`,
				'点击状态栏可立即刷新。'
			];
		} else if (snapshot.sourceKind === 'jijinhao') {
			tooltipLines = [
				'**中国金价**',
				'模式: `集金号实时行情 (Au99.99)`',
				`最新价: \`¥${formatNumber(snapshot.price, this.config.cnyPrecision)} / g\``,
				`相对上次刷新: \`${relativeDeltaText}\``,
				`源站涨跌: \`${formatSignedNumber(snapshot.change, this.config.deltaPrecision)}\``,
				isFiniteNumber(snapshot.open)
					? `今开: \`¥${formatNumber(snapshot.open, this.config.cnyPrecision)} / g\``
					: undefined,
				isFiniteNumber(snapshot.high)
					? `最高: \`¥${formatNumber(snapshot.high, this.config.cnyPrecision)} / g\``
					: undefined,
				isFiniteNumber(snapshot.low)
					? `最低: \`¥${formatNumber(snapshot.low, this.config.cnyPrecision)} / g\``
					: undefined,
				`数据时间: \`${formatTimestamp(snapshot.sourceUpdatedAt)}\``,
				`最近抓取: \`${formatTimestamp(snapshot.fetchedAt)}\``,
				`说明: ${snapshot.sourceDescription}`,
				`来源: [${snapshot.sourceLabel ?? '集金号实时行情'}](${snapshot.sourceUrl ?? 'https://gold.cngold.org/'})`,
				'点击状态栏可立即刷新。'
			].filter((line): line is string => Boolean(line));
		} else if (snapshot.sourceKind === 'proxy') {
			tooltipLines = [
				'**中国金价**',
				'模式: `实时人民币金参考价`',
				`最新价: \`¥${formatNumber(snapshot.price, this.config.cnyPrecision)} / g\``,
				`相对上次刷新: \`${relativeDeltaText}\``,
				`源站涨跌: \`${formatSignedNumber(snapshot.change, this.config.deltaPrecision)}\``,
				`今开: \`¥${formatNumber(snapshot.open ?? snapshot.price, this.config.cnyPrecision)} / g\``,
				`最高: \`¥${formatNumber(snapshot.high ?? snapshot.price, this.config.cnyPrecision)} / g\``,
				`最低: \`¥${formatNumber(snapshot.low ?? snapshot.price, this.config.cnyPrecision)} / g\``,
				`换算公式: \`伦敦金 × USD/CNY ÷ 31.1034768\``,
				`USD/CNY: \`${formatNumber(snapshot.fxRate ?? 0, 4)}\``,
				`伦敦金时间: \`${formatTimestamp(snapshot.goldUpdatedAt ?? snapshot.sourceUpdatedAt)}\``,
				`汇率时间: \`${formatTimestamp(snapshot.fxUpdatedAt ?? snapshot.sourceUpdatedAt)}\``,
				`最近抓取: \`${formatTimestamp(snapshot.fetchedAt)}\``,
				`说明: ${snapshot.sourceDescription}`,
				`来源: [${snapshot.sourceLabel ?? '伦敦金与汇率快照'}](${snapshot.sourceUrl ?? JD_GOLD_PAGE_URL})`,
				'点击状态栏可立即刷新。'
			];
		} else {
			tooltipLines = [
				'**中国金价**',
				'模式: `上金所延时行情`',
				`合约: \`${snapshot.symbol}\``,
				`最新价: \`¥${formatNumber(snapshot.price, this.config.cnyPrecision)} / g\``,
				`相对上次刷新: \`${relativeDeltaText}\``,
				`源站涨跌: \`${formatSignedNumber(snapshot.change, this.config.deltaPrecision)}\``,
				`今开: \`¥${formatNumber(snapshot.open ?? snapshot.price, this.config.cnyPrecision)} / g\``,
				`最高: \`¥${formatNumber(snapshot.high ?? snapshot.price, this.config.cnyPrecision)} / g\``,
				`最低: \`¥${formatNumber(snapshot.low ?? snapshot.price, this.config.cnyPrecision)} / g\``,
				`页面时间: \`${formatTimestamp(snapshot.sourceUpdatedAt)}\``,
				`最近抓取: \`${formatTimestamp(snapshot.fetchedAt)}\``,
				`说明: ${snapshot.sourceDescription}`,
				`来源: [${snapshot.sourceLabel ?? '上海黄金交易所延时行情'}](${snapshot.sourceUrl ?? SGE_DELAYED_QUOTE_URL})`,
				'点击状态栏可立即刷新。'
			];
		}

		this.chinaItem.tooltip = new vscode.MarkdownString(tooltipLines.join('\n\n'));
		this.chinaItem.show();
	}

	private renderInternationalError(message: string): void {
		if (!this.config.showInternational || !this.internationalItem) {
			this.internationalItem?.hide();
			return;
		}

		this.internationalItem.text = this.lastInternational
			? `$(warning) ${this.config.internationalLabel} $${formatNumber(this.lastInternational.price, this.config.usdPrecision)}`
			: `$(warning) ${this.config.internationalLabel} 失败`;
		this.internationalItem.color = this.colorForTrend('error');
		this.internationalItem.tooltip = new vscode.MarkdownString([
			'**国际金价刷新失败**',
			this.lastInternational
				? `上次成功值: \`$${formatNumber(this.lastInternational.price, this.config.usdPrecision)} / oz\``
				: '当前还没有可用的国际金价缓存。',
			`错误信息: \`${message}\``,
			'点击状态栏重试。'
		].join('\n\n'));
		this.internationalItem.show();
	}

	private renderChinaError(message: string): void {
		if (!this.config.showChina || !this.chinaItem) {
			this.chinaItem?.hide();
			return;
		}

		this.chinaItem.text = this.lastChina
			? `$(warning) ${this.config.chinaLabel} ¥${formatNumber(this.lastChina.price, this.config.cnyPrecision)}`
			: `$(warning) ${this.config.chinaLabel} 失败`;
		this.chinaItem.color = this.colorForTrend('error');
		this.chinaItem.tooltip = new vscode.MarkdownString([
			'**中国金价刷新失败**',
			this.lastChina
				? `上次成功值: \`¥${formatNumber(this.lastChina.price, this.config.cnyPrecision)} / g\``
				: '当前还没有可用的中国金价缓存。',
			`错误信息: \`${message}\``,
			'点击状态栏重试。'
		].join('\n\n'));
		this.chinaItem.show();
	}

	private scheduleNextRefresh(startedAtMs: number): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}

		if (!this.config.showInternational && !this.config.showChina) {
			return;
		}

		const elapsedMs = Date.now() - startedAtMs;
		const nominalDelay = Math.max(0, this.config.refreshIntervalMs - elapsedMs);
		const delay = this.errorCount > 0
			? Math.min(this.config.refreshIntervalMs * Math.pow(2, this.errorCount), 60_000)
			: nominalDelay;

		this.timer = setTimeout(() => {
			void this.refresh();
		}, delay);
	}

	private restoreSnapshots(): void {
		const saved = this.context.globalState.get<{
			lastInternational?: InternationalSnapshot;
			lastChina?: ChinaSnapshot;
		}>(SNAPSHOT_STORAGE_KEY);

		if (saved?.lastInternational) {
			this.lastInternational = saved.lastInternational;
			this.previousInternationalPrice = saved.lastInternational.price;
		}

		if (saved?.lastChina) {
			this.lastChina = saved.lastChina;
			this.previousChinaPrice = saved.lastChina.price;
		}
	}

	private async persistSnapshots(): Promise<void> {
		await this.context.globalState.update(SNAPSHOT_STORAGE_KEY, {
			lastInternational: this.lastInternational,
			lastChina: this.lastChina
		});
	}

	private colorForTrend(trend: Trend): string | vscode.ThemeColor {
		switch (trend) {
			case 'up':
				return resolveColor(this.config.upColor, '#dc2626');
			case 'down':
				return resolveColor(this.config.downColor, '#16a34a');
			case 'loading':
				return resolveColor(this.config.loadingColor, new vscode.ThemeColor('statusBar.foreground'));
			case 'error':
				return resolveColor(this.config.errorColor, new vscode.ThemeColor('statusBarItem.warningForeground'));
			case 'flat':
			default:
				return resolveColor(this.config.flatColor, new vscode.ThemeColor('statusBar.foreground'));
		}
	}
}

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(new GoldTickerController(context));
}

export function deactivate(): void {
	// VS Code 会自动释放 subscriptions。
}

function readConfig(): GoldTickerConfig {
	const config = vscode.workspace.getConfiguration('goldTicker');
	const alignment = config.get<string>('statusBarAlignment', 'left') === 'right'
		? vscode.StatusBarAlignment.Right
		: vscode.StatusBarAlignment.Left;
	const chinaSource = config.get<ChinaSource>('chinaSource', 'jdBank');
	const chinaBank = config.get<JdBankType>('chinaBank', 'minsheng');
	const defaultChinaLabel = chinaSource === 'sgeDelayed'
		? '上金所'
		: chinaSource === 'jdBank'
			? getJdBankMeta(chinaBank).label
		: chinaSource === 'jdSnapshot'
			? '国内金'
			: '人民币金';

	return {
		refreshIntervalMs: Math.max(1000, config.get<number>('refreshIntervalMs', 1000)),
		showInternational: config.get<boolean>('showInternational', true),
		showChina: config.get<boolean>('showChina', true),
		alignment,
		internationalLabel: config.get<string>('internationalLabel', '伦敦金'),
		chinaLabel: config.get<string>('chinaLabel', defaultChinaLabel),
		chinaSource,
		chinaBank,
		chinaSymbol: config.get<string>('chinaSymbol', 'Au99.99'),
		showDelta: config.get<boolean>('showDelta', true),
		usdPrecision: clampPrecision(config.get<number>('usdPrecision', 2)),
		cnyPrecision: clampPrecision(config.get<number>('cnyPrecision', 2)),
		deltaPrecision: clampPrecision(config.get<number>('deltaPrecision', 2)),
		upColor: config.get<string>('upColor', '#dc2626'),
		downColor: config.get<string>('downColor', '#16a34a'),
		flatColor: config.get<string>('flatColor', ''),
		loadingColor: config.get<string>('loadingColor', ''),
		errorColor: config.get<string>('errorColor', '')
	};
}

async function fetchSinaQuotes(codes: string[]): Promise<Record<string, SinaRawQuote>> {
	const uniqueCodes = Array.from(new Set(codes.filter(Boolean)));
	const text = await fetchTextWithRetry(`${SINA_HQ_BASE_URL}${uniqueCodes.join(',')}`, {
		Referer: SINA_REFERER,
		'User-Agent': 'Mozilla/5.0 GoldTickerStatusBar/0.0.5'
	});
	const quotes: Record<string, SinaRawQuote> = {};

	for (const match of text.matchAll(/var hq_str_([^=]+)="([^"]*)";/g)) {
		const code = match[1];
		quotes[code] = {
			code,
			fields: match[2].split(',')
		};
	}

	if (Object.keys(quotes).length === 0) {
		throw new Error('Sina 行情接口未返回可解析的报价');
	}

	return quotes;
}

async function fetchJdGoldQuoteSnapshot(): Promise<JdGoldQuoteSnapshot> {
	const response = await fetchJsonWithRetry<JdGoldQuoteResponse>(JD_GOLD_QUOTE_URL, {
		method: 'POST',
		headers: {
			Accept: 'application/json, text/plain, */*',
			'Content-Type': 'application/json',
			Origin: 'https://btfront.jd.com',
			Referer: JD_GOLD_PAGE_URL,
			'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) GoldTickerStatusBar/0.0.9',
			'X-Requested-With': 'XMLHttpRequest'
		},
		body: '{}'
	});

	const rows = response.resultData?.data?.goldQuoteVos;
	if (response.resultCode !== 0 || !Array.isArray(rows) || rows.length === 0) {
		throw new Error(response.resultMsg || response.resultData?.msg || '京东黄金快照接口未返回行情');
	}

	const quotes: Record<string, JdGoldQuote> = {};
	for (const row of rows) {
		if (!row?.uniqueCode) {
			continue;
		}

		const lastPrice = parseNumber(String(row.lastPrice ?? row.lastPriceText ?? ''));
		if (!Number.isFinite(lastPrice)) {
			continue;
		}

		quotes[row.uniqueCode] = {
			uniqueCode: row.uniqueCode,
			name: row.name ?? row.uniqueCode,
			lastPrice,
			lastPriceText: row.lastPriceText ?? String(lastPrice),
			raiseText: row.raiseText ?? '0',
			raisePercent100: row.raisePercent100 ?? '0%',
			rateValueColor: row.rateValueColor ?? ''
		};
	}

	if (Object.keys(quotes).length === 0) {
		throw new Error('京东黄金快照接口未返回可解析的报价');
	}

	const systime = response.resultData?.systime;
	return {
		quotes,
		sourceUpdatedAt: typeof systime === 'number' ? new Date(systime).toISOString() : new Date().toISOString(),
		fetchedAt: new Date().toISOString()
	};
}

async function fetchJdGoldProductSnapshot(bankType: JdBankType): Promise<JdGoldProductSnapshot> {
	const bankMeta = getJdBankMeta(bankType);
	const response = await fetchJsonWithRetry<JdGoldProductResponse>(
		`${JD_GOLD_PRODUCT_URL}?goldType=${bankMeta.goldType}`,
		{
			headers: {
				Accept: 'application/json, text/plain, */*',
				Origin: 'https://btfront.jd.com',
				Referer: JD_GOLD_PAGE_URL,
				'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) GoldTickerStatusBar/0.0.9',
				'X-Requested-With': 'XMLHttpRequest'
			}
		}
	);

	const data = response.resultData?.data;
	if (response.resultCode !== 0 || response.resultData?.code !== 0 || !data) {
		throw new Error(response.resultMsg || response.resultData?.msg || `${bankMeta.goldName}接口未返回行情`);
	}

	const price = parseRequiredNumber(String(data.priceValue ?? ''), `${bankMeta.goldName}最新价`);
	const points = (data.goldChartDataVOS ?? [])
		.map((item) => {
			const time = item?.value?.[0] ?? item?.name ?? '';
			const priceText = item?.value?.[1] ?? '';
			const pointPrice = parseNumber(priceText);
			return time && Number.isFinite(pointPrice)
				? {
					time,
					price: pointPrice
				}
				: undefined;
		})
		.filter((item): item is JdGoldProductPoint => Boolean(item));
	const fetchedAt = new Date().toISOString();
	const latestPoint = points.at(-1);

	return {
		productId: data.productId ?? '',
		goldName: data.goldName ?? bankMeta.goldName,
		price,
		change: parseSignedTextNumber(data.raise ?? '0'),
		changePercent: data.raisePercent100 ?? '',
		points,
		sourceUpdatedAt: latestPoint?.time ?? (
			typeof response.resultData?.systime === 'number'
				? new Date(response.resultData.systime).toISOString()
				: fetchedAt
		),
		fetchedAt
	};
}

async function fetchJijinhaoQuotes(codes: string[]): Promise<Record<string, JijinhaoQuote>> {
	const url = `${JIJINHAO_API_URL}?codes=${codes.join(',')}&currentPage=1&pageSize=${codes.length}`;
	const text = await fetchTextWithRetry(url, {
		'User-Agent': 'Mozilla/5.0 GoldTickerStatusBar/0.0.7',
		Referer: JIJINHAO_REFERER
	});

	const jsonStr = text.replace(/^var\s+quot_str\s*=\s*/, '').replace(/;\s*$/, '');
	const parsed = JSON.parse(jsonStr);
	const quotes: Record<string, JijinhaoQuote> = {};
	const dataItems: any[] = parsed?.[0]?.data ?? [];

	for (const item of dataItems) {
		const q = item?.quote;
		if (!q?.q124) {
			continue;
		}

		const price = parseFloat(q.q63);
		const previousClose = parseFloat(q.q64);

		if (!Number.isFinite(price)) {
			continue;
		}

		quotes[q.q124] = {
			code: q.q124,
			name: q.q67 ?? q.q68 ?? '',
			price,
			previousClose,
			open: parseFloat(q.q1) || 0,
			high: parseFloat(q.q3) || 0,
			low: parseFloat(q.q4) || 0,
			updatedAt: q.q59 ?? '',
			change: price - previousClose
		};
	}

	if (Object.keys(quotes).length === 0) {
		throw new Error('集金号接口未返回可解析的报价');
	}

	return quotes;
}

function parseJijinhaoInternational(quotes: Record<string, JijinhaoQuote>): InternationalSnapshot {
	const quote = quotes[JIJINHAO_CODE_XAU];

	if (!quote || !Number.isFinite(quote.price)) {
		throw new Error('未获取到集金号国际金价数据');
	}

	return {
		price: quote.price,
		open: quote.open,
		high: quote.high,
		low: quote.low,
		change: quote.change,
		sourceUpdatedAt: quote.updatedAt,
		fetchedAt: new Date().toISOString(),
		sourceLabel: '集金号实时行情',
		sourceDescription: '京东快照不可用时，回退到集金号伦敦金实时行情。',
		sourceUrl: 'https://gold.cngold.org/',
		quoteCode: '伦敦金 / JO_92233'
	};
}

function parseJijinaoChinaSnapshot(quotes: Record<string, JijinhaoQuote>): ChinaSnapshot {
	const quote = quotes[JIJINHAO_CODE_AU9999];

	if (!quote || !Number.isFinite(quote.price)) {
		throw new Error('未获取到集金号 Au9999 数据');
	}

	return {
		sourceKind: 'jijinhao',
		symbol: 'Au99.99',
		price: quote.price,
		open: quote.open,
		high: quote.high,
		low: quote.low,
		change: quote.change,
		sourceUpdatedAt: quote.updatedAt,
		fetchedAt: new Date().toISOString(),
		sourceDescription: '数据来自集金号实时行情，直接提供上金所 Au99.99 人民币/克报价，秒级更新。',
		sourceLabel: '集金号实时行情',
		sourceUrl: 'https://gold.cngold.org/',
		quoteCode: 'Au99.99 / JO_71'
	};
}

function parseJdBankSnapshot(snapshot: JdGoldProductSnapshot, bankType: JdBankType): ChinaSnapshot {
	const bankMeta = getJdBankMeta(bankType);
	const pointPrices = snapshot.points.map((point) => point.price);
	const open = pointPrices[0];
	const high = pointPrices.length > 0 ? Math.max(...pointPrices) : undefined;
	const low = pointPrices.length > 0 ? Math.min(...pointPrices) : undefined;

	return {
		sourceKind: 'jdBank',
		symbol: bankMeta.label,
		price: snapshot.price,
		open,
		high,
		low,
		change: snapshot.change,
		sourceUpdatedAt: snapshot.sourceUpdatedAt,
		fetchedAt: snapshot.fetchedAt,
		sourceDescription: `默认使用京东黄金盯盘页的${snapshot.goldName}。状态栏价格取接口返回的当前价，日内高低来自分钟走势图。`,
		sourceLabel: `京东黄金盯盘页 ${snapshot.goldName}`,
		sourceUrl: JD_GOLD_PAGE_URL,
		quoteCode: bankMeta.quoteCode
	};
}

function parseJdInternationalSnapshot(snapshot: JdGoldQuoteSnapshot): InternationalSnapshot {
	const quote = snapshot.quotes[JD_LONDON_GOLD_CODE];
	if (!quote) {
		throw new Error('京东黄金快照中未包含伦敦金报价');
	}

	return {
		price: quote.lastPrice,
		change: parseSignedTextNumber(quote.raiseText),
		sourceUpdatedAt: snapshot.sourceUpdatedAt,
		fetchedAt: snapshot.fetchedAt,
		sourceLabel: '京东黄金盯盘页快照',
		sourceDescription: '默认优先使用京东黄金盯盘页面的伦敦金快照，口径与页面展示一致。',
		sourceUrl: JD_GOLD_PAGE_URL,
		quoteCode: '伦敦金 / WG-XAUUSD'
	};
}

function parseJdChinaSnapshot(snapshot: JdGoldQuoteSnapshot): ChinaSnapshot {
	const quote = snapshot.quotes[JD_CHINA_GOLD_CODE];
	if (!quote) {
		throw new Error('京东黄金快照中未包含 Au99.99 报价');
	}

	return {
		sourceKind: 'jdSnapshot',
		symbol: 'Au99.99',
		price: quote.lastPrice,
		change: parseSignedTextNumber(quote.raiseText),
		sourceUpdatedAt: snapshot.sourceUpdatedAt,
		fetchedAt: snapshot.fetchedAt,
		sourceDescription: '这是京东黄金盯盘页面里的 Au99.99 快照，作为兼容旧配置保留。',
		sourceLabel: '京东黄金盯盘页快照',
		sourceUrl: JD_GOLD_PAGE_URL,
		quoteCode: 'Au99.99 / SGE-Au99.99'
	};
}

function parseLondonGoldSnapshot(quotes: Record<string, SinaRawQuote>): InternationalSnapshot {
	const quote = quotes[SINA_LONDON_GOLD_CODE];

	if (!quote || quote.fields.length < 13) {
		throw new Error('未获取到伦敦金报价');
	}

	const price = parseRequiredNumber(quote.fields[0], '伦敦金最新价');
	const previousClose = parseRequiredNumber(quote.fields[1], '伦敦金昨收');
	const open = parseRequiredNumber(quote.fields[3], '伦敦金今开');
	const high = parseRequiredNumber(quote.fields[4], '伦敦金最高');
	const low = parseRequiredNumber(quote.fields[5], '伦敦金最低');
	const time = quote.fields[6].trim();
	const date = quote.fields[12].trim();

	return {
		price,
		open,
		high,
		low,
		change: price - previousClose,
		sourceUpdatedAt: `${date} ${time}`,
		fetchedAt: new Date().toISOString(),
		sourceLabel: 'Sina 伦敦金行情',
		sourceDescription: '京东快照不可用时，回退到 Sina 伦敦金行情接口。',
		sourceUrl: 'https://hq.sinajs.cn/list=hf_XAU',
		quoteCode: '伦敦金 / hf_XAU'
	};
}

function parseUsdCnySnapshot(quotes: Record<string, SinaRawQuote>): FxSnapshot {
	const quote = quotes[SINA_USD_CNY_CODE];

	if (!quote || quote.fields.length < 10) {
		throw new Error('未获取到美元人民币报价');
	}

	const time = quote.fields[0].trim();
	const rate = parseRequiredNumber(quote.fields[1], '美元人民币最新价');
	const date = quote.fields[10]?.trim() ?? new Date().toISOString().slice(0, 10);

	return {
		rate,
		sourceUpdatedAt: `${date} ${time}`,
		fetchedAt: new Date().toISOString()
	};
}

function parseJdUsdCnhSnapshot(snapshot: JdGoldQuoteSnapshot): FxSnapshot {
	const quote = snapshot.quotes[JD_USD_CNH_CODE];
	if (!quote) {
		throw new Error('京东黄金快照中未包含 USD/CNH 汇率');
	}

	return {
		rate: quote.lastPrice,
		sourceUpdatedAt: snapshot.sourceUpdatedAt,
		fetchedAt: snapshot.fetchedAt
	};
}

function buildProxyChinaSnapshot(
	international: InternationalSnapshot,
	fx: FxSnapshot
): ChinaSnapshot {
	const openUsd = international.open ?? international.price;
	const highUsd = international.high ?? international.price;
	const lowUsd = international.low ?? international.price;

	return {
		sourceKind: 'proxy',
		symbol: 'XAU/CNY',
		price: convertUsdPerOunceToCnyPerGram(international.price, fx.rate),
		open: convertUsdPerOunceToCnyPerGram(openUsd, fx.rate),
		high: convertUsdPerOunceToCnyPerGram(highUsd, fx.rate),
		low: convertUsdPerOunceToCnyPerGram(lowUsd, fx.rate),
		change: convertUsdPerOunceToCnyPerGram(international.change, fx.rate),
		sourceUpdatedAt: international.sourceUpdatedAt,
		fetchedAt: new Date().toISOString(),
		fxRate: fx.rate,
		goldUpdatedAt: international.sourceUpdatedAt,
		fxUpdatedAt: fx.sourceUpdatedAt,
		sourceDescription: '采用伦敦金实时价按 USD/CNY 换算成人民币/克，更新速度通常快于上金所延时页。',
		sourceLabel: international.sourceLabel?.includes('京东')
			? '京东伦敦金 + 京东 USD/CNH'
			: 'Sina 伦敦金 + Sina USD/CNY',
		sourceUrl: international.sourceLabel?.includes('京东')
			? JD_GOLD_PAGE_URL
			: 'https://hq.sinajs.cn/list=hf_XAU',
		quoteCode: 'XAU/CNY'
	};
}

async function fetchSgeChinaSnapshot(symbol: string): Promise<ChinaSnapshot> {
	const html = await fetchTextWithRetry(SGE_DELAYED_QUOTE_URL, {
		'User-Agent': 'Mozilla/5.0 GoldTickerStatusBar/0.0.5'
	});
	const rows = parseSgeRows(html);
	const row = rows.find((item) => item.symbol === symbol);

	if (!row) {
		const available = rows.map((item) => item.symbol).slice(0, 8).join(', ');
		throw new Error(`上金所页面未找到合约 ${symbol}。可用示例：${available}`);
	}

	return {
		sourceKind: 'sgeDelayed',
		symbol: row.symbol,
		price: row.price,
		open: row.open,
		high: row.high,
		low: row.low,
		change: 0,
		sourceUpdatedAt: extractSgePageDate(html),
		fetchedAt: new Date().toISOString(),
		sourceDescription: '这是上海黄金交易所官网延时行情，数值更贴近上金所口径，但并非秒级实时盘口。',
		sourceLabel: '上海黄金交易所延时行情',
		sourceUrl: SGE_DELAYED_QUOTE_URL,
		quoteCode: row.symbol
	};
}

function parseSgeRows(html: string): SgeRow[] {
	const rows: SgeRow[] = [];

	for (const rowMatch of html.matchAll(/<tr class="ininfo">([\s\S]*?)<\/tr>/gi)) {
		const cells = Array.from(
			rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi),
			(cellMatch) => cleanHtmlText(cellMatch[1])
		);

		if (cells.length < 5) {
			continue;
		}

		const [symbol, priceText, highText, lowText, openText] = cells;
		const price = parseNumber(priceText);
		const high = parseNumber(highText);
		const low = parseNumber(lowText);
		const open = parseNumber(openText);

		if (!symbol || !Number.isFinite(price)) {
			continue;
		}

		rows.push({
			symbol,
			price,
			high,
			low,
			open
		});
	}

	return rows;
}

async function fetchTextWithRetry(
	url: string,
	headers: Record<string, string>,
	timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
	retries = 1
): Promise<string> {
	const response = await fetchWithRetry(url, { headers }, timeoutMs, retries);
	return await response.text();
}

async function fetchJsonWithRetry<T>(
	url: string,
	init: RequestInit,
	timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
	retries = 1
): Promise<T> {
	const response = await fetchWithRetry(url, init, timeoutMs, retries);
	return await response.json() as T;
}

async function fetchWithRetry(
	url: string,
	init: RequestInit,
	timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
	retries = 1
): Promise<Response> {
	let lastError: unknown;

	for (let attempt = 0; attempt <= retries; attempt += 1) {
		try {
			const response = await fetch(url, {
				...init,
				signal: AbortSignal.timeout(timeoutMs)
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status} ${response.statusText}`);
			}

			return response;
		} catch (error) {
			lastError = error;
			if (attempt < retries) {
				await delay(500 * (attempt + 1));
			}
		}
	}

	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function extractSgePageDate(html: string): string {
	const titleDate = html.match(/<h1>上海黄金交易所([^<]+)延时行情<\/h1>/i)?.[1]?.trim();
	const fallbackDate = html.match(/<p class="date">([^<]+)<\/p>/i)?.[1]?.trim();
	return titleDate || fallbackDate || '未知';
}

function convertUsdPerOunceToCnyPerGram(usdPerOunce: number, usdCny: number): number {
	return (usdPerOunce * usdCny) / OUNCES_TO_GRAMS;
}

function getTrend(delta: number, previous: number | undefined): Trend {
	if (previous === undefined) {
		return 'flat';
	}

	if (delta > 0) {
		return 'up';
	}

	if (delta < 0) {
		return 'down';
	}

	return 'flat';
}

function getTrendFromChange(change: number): Trend {
	if (change > 0) {
		return 'up';
	}

	if (change < 0) {
		return 'down';
	}

	return 'flat';
}

function formatDelta(
	delta: number,
	trend: Trend,
	showDelta: boolean,
	hasPrevious: boolean,
	precision: number
): string {
	if (!showDelta || !hasPrevious) {
		return '';
	}

	const prefix = trend === 'up' ? '▲' : trend === 'down' ? '▼' : '■';
	return `${prefix}${formatSignedNumber(delta, precision)}`;
}

function formatNumber(value: number, precision: number): string {
	return value.toFixed(precision);
}

function formatSignedNumber(value: number, precision: number): string {
	const sign = value > 0 ? '+' : '';
	return `${sign}${value.toFixed(precision)}`;
}

function formatTimestamp(value: string): string {
	const date = new Date(value);

	if (Number.isNaN(date.getTime())) {
		return value;
	}

	return new Intl.DateTimeFormat(undefined, {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	}).format(date);
}

function clampPrecision(value: number): number {
	return Math.max(0, Math.min(4, value));
}

function resolveColor(
	configuredValue: string,
	fallback: string | vscode.ThemeColor
): string | vscode.ThemeColor {
	return configuredValue.trim() ? configuredValue : fallback;
}

function cleanHtmlText(value: string): string {
	return value
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&#39;/gi, '\'')
		.replace(/&quot;/gi, '"')
		.replace(/\s+/g, ' ')
		.trim();
}

function parseNumber(value: string): number {
	return Number.parseFloat(value.replace(/,/g, '').trim());
}

function parseRequiredNumber(value: string, fieldName: string): number {
	const parsed = parseNumber(value);

	if (!Number.isFinite(parsed)) {
		throw new Error(`${fieldName} 不是有效数字`);
	}

	return parsed;
}

function parseSignedTextNumber(value: string): number {
	const parsed = parseNumber(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function isFiniteNumber(value: number | undefined): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function toSettledErrorMessage<T>(result: PromiseSettledResult<T | undefined>): string {
	return result.status === 'rejected' ? toErrorMessage(result.reason) : '未知错误';
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

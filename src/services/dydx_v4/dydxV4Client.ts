import {
	BECH32_PREFIX,
	IndexerClient,
	CompositeClient,
	Network,
	SubaccountClient,
	ValidatorConfig,
	LocalWallet,
	OrderExecution,
	OrderSide,
	OrderTimeInForce,
	OrderType,
	IndexerConfig
} from '@dydxprotocol/v4-client-js';
import { dydxV4OrderParams, AlertObject, OrderResult } from '../../types';
import { _sleep, doubleSizeIfReverseOrder } from '../../helper';
import 'dotenv/config';
import config from 'config';
import { AbstractDexClient } from '../abstractDexClient';

export class DydxV4Client extends AbstractDexClient {
	async getIsAccountReady() {
		const subAccount = await this.getSubAccount();
		if (!subAccount) return false;

		console.log('dydx v4 account: ' + JSON.stringify(subAccount, null, 2));
		return (Number(subAccount.freeCollateral) > 0) as boolean;
	}

	async getSubAccount() {
		try {
			const client = this.buildIndexerClient();
			const localWallet = await this.generateLocalWallet();
			if (!localWallet) return;
			const response = await client.account.getSubaccount(
				localWallet.address,
				0
			);

			return response.subaccount;
		} catch (error) {
			console.error(error);
		}
	}

	async buildOrderParams(alertMessage: AlertObject) {
		const orderSide =
			alertMessage.order == 'buy' ? OrderSide.BUY : OrderSide.SELL;

		const latestPrice = alertMessage.price;
		console.log('latestPrice', latestPrice);

		let orderSize: number;
		if (alertMessage.sizeByLeverage) {
			const account = await this.getSubAccount();

			orderSize =
				(Number(account.equity) * Number(alertMessage.sizeByLeverage)) /
				latestPrice;
		} else if (alertMessage.sizeUsd) {
			orderSize = Number(alertMessage.sizeUsd) / latestPrice;
		} else {
			orderSize = alertMessage.size;
		}

		orderSize = doubleSizeIfReverseOrder(alertMessage, orderSize);

		const market = alertMessage.market.replace(/_/g, '-');

		const orderParams: dydxV4OrderParams = {
			market,
			side: orderSide,
			size: Number(orderSize),
			price: Number(alertMessage.price)
		};
		console.log('orderParams for dydx', orderParams);
		return orderParams;
	}

	async placeOrder(alertMessage: AlertObject) {
	const orderParams = await this.buildOrderParams(alertMessage);
	const { client, subaccount } = await this.buildCompositeClient();

	const market = orderParams.market;
	const type = OrderType.MARKET;
	const side = orderParams.side;
	const timeInForce = OrderTimeInForce.GTT;
	const execution = OrderExecution.DEFAULT;
	const slippagePercentage = 0.05;
	const price = side === OrderSide.BUY
		? orderParams.price * (1 + slippagePercentage)
		: orderParams.price * (1 - slippagePercentage);
	const size = orderParams.size;

	try {
		const clientId = this.generateRandomInt32();
		console.log('Client ID: ', clientId);

		const tx = await client.placeOrder(
			subaccount,
			market,
			type,
			side,
			price,
			size,
			clientId,
			timeInForce,
			120000,
			execution,
			false,
			false,
			null
		);

		console.log('Transaction Result: ', tx);
		await _sleep(60000); // 1 minute d'attente pour le fill

		const orderResult: OrderResult = {
			side: orderParams.side,
			size: orderParams.size,
			orderId: String(clientId),
		};

		// ✅ Ajout TP
		if (alertMessage.tp) {
			await client.placeOrder(
				subaccount,
				market,
				OrderType.TAKE_PROFIT_MARKET,
				side === OrderSide.BUY ? OrderSide.SELL : OrderSide.BUY,
				alertMessage.tp,
				size,
				this.generateRandomInt32(),
				OrderTimeInForce.GTT,
				120000,
				OrderExecution.DEFAULT,
				false,
				true, // reduce only
				alertMessage.tp // trigger price
			);
			console.log(`TP placé à ${alertMessage.tp}`);
		}

		// ✅ Ajout SL
		if (alertMessage.sl) {
			await client.placeOrder(
				subaccount,
				market,
				OrderType.STOP_MARKET,
				side === OrderSide.BUY ? OrderSide.SELL : OrderSide.BUY,
				alertMessage.sl,
				size,
				this.generateRandomInt32(),
				OrderTimeInForce.GTT,
				120000,
				OrderExecution.DEFAULT,
				false,
				true, // reduce only
				alertMessage.sl // trigger price
			);
			console.log(`SL placé à ${alertMessage.sl}`);
		}

		return orderResult;
	} catch (error) {
		console.error(error);
		throw new Error('Failed to place order with TP/SL');
	}
}


	private buildCompositeClient = async () => {
		const validatorConfig = new ValidatorConfig(
			config.get('DydxV4.ValidatorConfig.restEndpoint'),
			'dydx-mainnet-1',
			{
				CHAINTOKEN_DENOM: 'adydx',
				CHAINTOKEN_DECIMALS: 18,
				USDC_DENOM:
					'ibc/8E27BA2D5493AF5636760E354E46004562C46AB7EC0CC4C1CA14E9E20E2545B5',
				USDC_GAS_DENOM: 'uusdc',
				USDC_DECIMALS: 6
			}
		);
		const network =
			process.env.NODE_ENV == 'production'
				? new Network('mainnet', this.getIndexerConfig(), validatorConfig)
				: Network.testnet();
		let client;
		try {
			client = await CompositeClient.connect(network);
		} catch (e) {
			console.error(e);
			throw new Error('Failed to connect to dYdX v4 client');
		}

		const localWallet = await this.generateLocalWallet();
		const subaccount = new SubaccountClient(localWallet, 0);
		return { client, subaccount };
	};

	private generateLocalWallet = async () => {
		if (!process.env.DYDX_V4_MNEMONIC) {
			console.log('DYDX_V4_MNEMONIC is not set as environment variable');
			return;
		}

		const localWallet = await LocalWallet.fromMnemonic(
			process.env.DYDX_V4_MNEMONIC,
			BECH32_PREFIX
		);
		console.log('dYdX v4 Address:', localWallet.address);

		return localWallet;
	};

	private buildIndexerClient = () => {
		const mainnetIndexerConfig = this.getIndexerConfig();
		const indexerConfig =
			process.env.NODE_ENV !== 'production'
				? Network.testnet().indexerConfig
				: mainnetIndexerConfig;
		return new IndexerClient(indexerConfig);
	};

	private getIndexerConfig = () => {
		return new IndexerConfig(
			config.get('DydxV4.IndexerConfig.httpsEndpoint'),
			config.get('DydxV4.IndexerConfig.wssEndpoint')
		);
	};

	private generateRandomInt32(): number {
		const maxInt32 = 2147483647;
		return Math.floor(Math.random() * (maxInt32 + 1));
	}

	private isOrderFilled = async (clientId: string): Promise<boolean> => {
		const orders = await this.getOrders();

		const order = orders.find((order) => {
			return order.clientId == clientId;
		});
		if (!order) return false;

		console.log('dYdX v4 Order ID: ', order.id);

		return order.status == 'FILLED';
	};

	getOrders = async () => {
		const client = this.buildIndexerClient();
		const localWallet = await this.generateLocalWallet();
		if (!localWallet) return;

		return await client.account.getSubaccountOrders(localWallet.address, 0);
	};
}

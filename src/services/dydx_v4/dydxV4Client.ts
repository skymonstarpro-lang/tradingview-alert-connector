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
			price: Number(alertMessage.price),
			tp,
			sl
		};
		console.log('orderParams for dydx', orderParams);
		return orderParams;
	}

	async placeOrder(alertMessage: AlertMessage): Promise<void> {
  const market = alertMessage.market.replace('-', '_'); // ETH-USD → ETH_USD
  const orderSide = alertMessage.order.toUpperCase(); // BUY or SELL
  const orderSize = alertMessage.size;
  const price = alertMessage.price;
  const tp = alertMessage.tp;
  const sl = alertMessage.sl;

  console.log('orderParams for dydx', {
    market,
    side: orderSide,
    size: orderSize,
    price: price,
	tp: tp,
	sl: sl
  });

  // 🟢 1. Ordre principal (ex: market BUY)
  const orderParams: dydxV4OrderParams = {
    market,
    side: orderSide,
    size: Number(orderSize),
    price: Number(price),
    type: 'MARKET' // ou 'LIMIT' si tu veux le rendre configurable
  };

  await this.client.placeOrder(orderParams);

  // 🟢 2. Optionnel : Take Profit / Stop Loss
  const tp = alertMessage.tp;
  const sl = alertMessage.sl;

  const oppositeSide = orderSide === 'BUY' ? 'SELL' : 'BUY';

  // Place TP
  if (tp) {
    const tpOrder: dydxV4OrderParams = {
      market,
      side: oppositeSide,
      size: Number(orderSize),
      triggerPrice: Number(tp),
      type: 'TAKE_PROFIT_MARKET',
      reduceOnly: true
    };
    console.log('Placing TP:', tpOrder);
    await this.client.placeOrder(tpOrder);
  }

  // Place SL
  if (sl) {
    const slOrder: dydxV4OrderParams = {
      market,
      side: oppositeSide,
      size: Number(orderSize),
      triggerPrice: Number(sl),
      type: 'STOP_MARKET',
      reduceOnly: true
    };
    console.log('Placing SL:', slOrder);
    await this.client.placeOrder(slOrder);
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

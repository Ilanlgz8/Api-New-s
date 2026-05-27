export type CryptoSparkline = {
  price: number[];
};

export type CryptoCoin = {
  id: string;
  symbol: string;
  name: string;
  image?: string;
  current_price: number;
  price_change_percentage_24h: number;
  high_24h?: number;
  low_24h?: number;
  total_volume: number;
  sparkline_in_7d?: CryptoSparkline;
};

export type CryptoApiResponse = CryptoCoin[];

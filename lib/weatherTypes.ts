export type WeatherIconKey = 'Clear' | 'Clouds' | 'Rain' | 'Drizzle' | 'Thunderstorm' | 'Snow' | 'Mist' | 'Fog' | string;

export type WeatherDescription = {
  main: WeatherIconKey;
  description: string;
};

export type WeatherCurrent = {
  weather: WeatherDescription[];
  main: {
    temp: number;
    feels_like: number;
    humidity: number;
    pressure: number;
  };
  wind: {
    speed: number;
  };
};

export type WeatherForecastItem = {
  dt: number;
  weather: WeatherDescription[];
  main: {
    temp: number;
  };
};

export type WeatherForecast = {
  list: WeatherForecastItem[];
};

export type WeatherApiResponse = {
  current: WeatherCurrent;
  forecast?: WeatherForecast | null;
};

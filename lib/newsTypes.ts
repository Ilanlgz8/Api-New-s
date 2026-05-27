export type NewsCountry = 'fr' | 'us' | 'gb';

export type NewsSource = {
  name?: string;
};

export type NewsArticle = {
  title?: string;
  url?: string;
  urlToImage?: string | null;
  publishedAt?: string;
  source?: NewsSource;
};

export type NewsApiResponse = {
  articles?: NewsArticle[];
};

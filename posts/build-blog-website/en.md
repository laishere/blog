---
title: Building a Blog Website with Remix
---

Recently, I have been learning about [`Remix`](https://remix.run/) and had the idea of creating my own blog website, so I built this blog site using Remix technology. The blog is based on a model that separates the website from its content, deploying the site on `Vercel` and using a `GitHub repository` as the database to store the blog content.

The main technologies used are: `Remix`, `React`, and `TailwindCSS`.

For handling Markdown files: `FrontMatter`, `Remark`, `Shiki`, and `Rehype`.

Since the UI is relatively simple, I did not use a UI framework but chose to code all the UI myself.

**Links:**
- [Website source code](https://github.com/laishere/blog-website)
- [Blog content repository](https://github.com/laishere/blog)

## Architecture

<img class="light" style="max-width:60%" src="https://i.ibb.co/wpjG0Ms/arch-light.png" alt="Website Architecture Diagram" />
<img class="dark" style="max-width:60%" src="https://i.ibb.co/sqMFCHs/arch-dark.png" alt="Website Architecture Diagram" />

As shown in the diagram above, the Remix website service acts as a stateless component that provides page rendering for users. The website service directly accesses the database to query article content and other data. The blog site needs to support `SEO` (Search Engine Optimization), typically using `SSR` (Server-Side Rendering) or `SSG` (Static-Site Generation).

This site chooses to adopt SSR mode. Why?
- I want to separate content from the website.
- I don't want to redeploy the website when updating content.

So what are the drawbacks of SSR compared to directly using SSG?
- Requires a server, cannot be purely static deployment
- SSR is harder to cache long-term, which can affect access speed

However, SSR is not without its merits; in fact, many websites still use SSR rather than SSG. For example, the famous blog site framework `WordPress` is rendered by `PHP`. Using SSR does not require redeploying every time content is modified like SSG, making it more suitable for frequently updated dynamic content websites.

Some might say that CI/CD is so common now, wouldn't it be better to just write a Workflow for automated deployment?
- Redeploying the entire website takes longer
- Redeployment may lead to cache clearing (e.g., when using Vercel as the deployment solution)
- Not everyone understands technology; many blog creators focus solely on content creation

In summary, using SSR lowers the barrier for content creation and makes building a website easier, which might explain why WordPress remains popular today.

Moreover, the computational power of SSR makes it easier to implement certain scenario requirements. For example: seamless support for dark/light mode.

Color scheme switching can also be directly supported using JavaScript in the browser, but what’s the difference?

Here’s a simple step-by-step example of switching color schemes using only client-side JavaScript:
1. The browser loads the page
2. JavaScript checks if the color scheme matches
3. If it doesn't match, it switches

This presents a problem: if the browser loads a light-themed page, the user immediately sees a light page after step 1, and then quickly sees a dark page after steps 2 and 3 complete. There will be a **flash screen** phenomenon in between.

Using SSR, however, the rendering can occur based on user settings, which are typically stored in cookies, and the server can render the final color scheme directly, so there is **no flash screen**.

Of course, SSG can also achieve this effect through certain means, such as:
- Storing color scheme parameters directly in the URL
- Using a reverse proxy to automatically forward requests to the appropriate URL based on cookie information, which hides the client-side URL parameters for a cleaner look but is more complex

All the above methods require SSG to generate all supported color schemes, and either the URLs are not concise enough, or they depend on server configurations, which can be overly complicated.

In conclusion, choosing SSR doesn’t seem like a bad choice. However, does choosing SSR mean it will always perform worse than SSG? 

**Not necessarily!** If we can effectively utilize caching as SSG does, we can achieve performance very close to that of SSG.

## Caching✨

<img class="light" style="max-width:60%" src="https://i.ibb.co/YP7207v/cache-light.png" alt="Caching Architecture Diagram" />
<img class="dark" style="max-width:60%" src="https://i.ibb.co/Kzjv3J6/cache-dark.png" alt="Caching Architecture Diagram" />

In simple terms, when content hasn’t changed, we want to leverage cached results directly; when content does change, we will re-render and update the cache.

### Memory/Redis Cache

The choice of cache depends on the deployment plan. If deployed on a personal server, we can use memory and file caching directly. However, I chose to deploy on `Vercel`.

Vercel’s solution is a `Serverless` one, so we can’t rely on file caching. But can we use memory caching? After testing, the answer is **yes**. However, memory caching does not guarantee persistence and is local caching; we can only set long-term local caching when the cached content for a specific key can be guaranteed to remain unchanged over time. If the cached content is likely to change frequently, we need **reliable cache refresh mechanisms**, and clearly, distributed serverless setups make it hard to refresh each deployed local cache.

Are there other low-latency centralized/synchronized caching solutions? Yes, there’s `Redis` and other Key-Value databases. For content that needs to be updated promptly, we can use a multi-level caching scheme with `short-term memory cache` + `long-term Redis cache`. 
While `memory cache` may cause some update delays, it can reduce the query frequency to `Redis cache`.

I wrote a simple multi-level caching logic:
```ts filename=app/lib/cache.server.ts lines=[30-46,52-59]
export async function withMemCache<T>(
  {
    key,
    expireSeconds,
    useRedis = false,
    debounce = true,
    redisExpire = expireSeconds,
  }: MemCacheOptions,
  load: () => Promise<T>
): Promise<T> {
  if (serverConfig.disableCache) {
    return load();
  }
  if (debounce && debounceMap.has(key)) {
    return debounceMap.get(key) as Promise<T>;
  }
  const task = (async () => {
    const now = Date.now();
    const cache = memCache.get(key);
    if (cache && cache.expire > now) {
      console.log("Memory cache hit:", key);
      return cache.data as T;
    }
    const tasks = [load()];
    const shouldUseRedis = useRedis && hasRedis();
    let shouldWriteRedis = shouldUseRedis;
    let resolved = false;
    if (shouldUseRedis) {
      tasks.push(
        (async () => {
          const redisGetStart = Date.now();
          const redisCache = await redisGet(key);
          if (!redisCache) {
            console.log("Redis cache miss:", key);
            throw new Error("Redis cache miss");
          }
          console.log(
            `Redis cache hit in ${Date.now() - redisGetStart}ms:`,
            key
          );
          shouldWriteRedis = false; // No need to write back to Redis
          if (resolved) {
            console.warn("Redis is slower than load:", key);
          }
          return JSON.parse(redisCache);
        })()
      );
    }
    const data = await successRace(tasks);
    resolved = true;
    memCache.set(key, { expire: now + expireSeconds * 1000, data });
    if (shouldWriteRedis) {
      const redisSetStart = Date.now();
      redisSet(key, JSON.stringify(data), redisExpire)
        .then(() => {
          console.log(`Redis write time ${Date.now() - redisSetStart}ms:`, key);
        })
        .catch(console.error);
    }
    return data;
  })();
  debounceMap.set(key, task);
  return task.finally(() => {
    debounceMap.delete(key);
  });
}
```

For Redis, I’m using the free tier from [Upstash](https://upstash.com/), which allows *10K commands per day* for free. After testing, the read latency in the same region is about **50+ms**, sometimes within a few milliseconds, but not particularly stable.

When the memory cache does not hit, we query the Redis cache, **but since there might be a `MISS` in the Redis cache, if we wait idly, we could end up spending over 50ms to request the content.** Thus, I chose to query Redis and initiate the content request simultaneously, then select the **first successful** response. Generally speaking, Redis queries are faster, and if the Redis cache hits, we will directly use the Redis cache.

Here’s a simple wrapper for `Promise.race`:

```ts
async function successRace<T>(promises: Promise<T>[]): Promise<T> {
  const ret = await Promise.race(
    promises.map((p) =>
      p.then(
        (value) => ({ p, value }),
        (error) => ({ p, error })
      )
    )
  );
  if ("value" in ret) {
    return ret.value;
  }
  const rest = promises.filter((p) => p !== ret.p);
  if (rest.length === 0) {
    throw ret.error;
  }
  return successRace(rest);
}
```

Besides memory and Redis caching, are there other caching solutions? *After all, Redis free quota is limited* 🤣

### CDN Cache

Following the principle of saving where possible, when caching large volumes of content, we can directly use CDN caching. CDNs not only serve clients directly but can also act as a caching container for servers via **self-request**. We treat the content that needs caching as independent route to control the caching time for each piece of content.

```ts filename=app/routes/cache.$target.$.ts lines=[6-13,19-27]
export async function loader({ params, request }: LoaderFunctionArgs) {
  setRequestContext(request);
  const { target } = params;
  try {
    if (target === "meta") {
      const ret = await loadPostsMeta();
      return new Response(JSON.stringify(ret), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control":
            "public, max-age=60, s-maxage=60, stale-while-revalidate=60",
        },
      });
    } else if (target === "post") {
      const parts = params["*"]!.split("/");
      if (parts.length !== 3) {
        throw new Response("Bad Request", { status: 400 });
      }
      const [lang, slug, version] = parts;
      const ret = await loadRenderPost(lang, slug, version);
      return new Response(JSON.stringify(ret), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control":
            "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
        },
      });
    }
  } catch (error) {
    if (error === FileNotFoundError) {
      throw new Response("Not Found", { status: 404 });
    }
    throw error;
  }
  throw new Response("Bad Request", { status: 400 });
}
```

Currently, it is mainly used for caching `meta` (blog content metadata) and `post` (blog article content). The expiration time for `post` cache is the longest, with a maximum expiration time of `86400 + 604800` seconds, or 8 days.

Some may ask: Hey, isn’t blog content subject to updates? How can you cache it for so long? — Oh, it must be that CDN provides cache purging support!

Not really! I’m using Vercel’s `Edge Caching`. According to [Vercel’s documentation](https://vercel.com/docs/edge-network/caching#cache-invalidation):
> The cache is automatically purged upon a new deployment being created. 
If you ever need to invalidate Vercel's Edge Network cache, you can always re-deploy.

This means we can only clear the cache by redeploying the website.

WTF? Every time I update an article, I have to redeploy the website. Doesn’t that nullify the benefits of a separated design?

Of course, it’s not necessary to redeploy. As long as we ensure the article **_"remains unchanged"_**, that’s fine! — Although the article will be updated, we just need to append a version number, so each version of the article remains unchanged. This is a common method in frontend packaging using `hash` versioning. Therefore, each time we update the article content, we request a new version, and the version information will be in the URL, allowing the CDN to request and cache the new article version for us!

So where is this version information stored? The article’s version and other information are stored in the `meta` metadata, which is why we set such a short caching time for `meta`. **The update delay of `meta` corresponds to the update delay of the article.**

**In summary, this site employs a multi-level caching scheme of `memory` + `Redis` + `CDN`. At the same time, we use versioning methods to classify easily updated content into fixed, unchanging versions, thus making it easier to use in caching schemes that cannot be actively updated.**

## `meta` Preprocessing and Content Querying

As mentioned above, the article version needs to be retrieved from `meta`, but how is `meta` obtained? And how does the website service query the corresponding article content?

### `meta` Preprocessing

`meta` is the metadata for all articles. To obtain this metadata, it can be either edited manually or generated automatically. Of course, we choose automatic generation as it is more accurate and time-saving.

As mentioned at the beginning of the article, the blog content is stored in a `GitHub repository`. We can utilize `GitHub Actions` to automatically generate `meta` whenever an article is updated and simultaneously initiate a cache refresh request to the website service.

```ts filename=app/routes/cache.$target.$.ts
export async function action({ params }: ActionFunctionArgs) {
  if (params.target === "purge") {
    const secret = params["*"];
    if (!secret || secret !== serverConfig.cachePurgeSecret) {
      throw new Response("Forbidden", { status: 403 });
    }
    purgePostsMetaCache();
    return new Response("OK", { status: 200 });
  }
  throw new Response("Bad Request", { status: 400 });
}
```

The function above is responsible for handling the cache refresh operation. To prevent attacks, I have set a password verification process for the cache clearing operation. 
The `purgePostsMetaCache` function is responsible for clearing the local `memory cache` and the `Redis cache` for `meta`.

### Article Content Query

The [GitHub REST API](https://docs.github.com/en/rest) provides a way to access `GitHub repositories`. Here, we use the [Repositories/Contents](https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28#get-repository-content) endpoint.

To do this, we need to obtain credentials provided by GitHub. There are three types of credentials: `PAT (Personal Access Token)`, `GitHub Apps`, and `GitHub OAuth`. Since this is for personal use, it’s natural to choose `PAT`. Generating a `PAT` is also straightforward; just go to the personal settings page, select Developer settings, and choose to create the latest `Fine-Grained PAT`. This credential provides fine-grained permission control, allowing access to specific permissions for certain repositories only.

## Blog Content Rendering

Blog content is written in `Markdown` format, and `Front Matter` is used to record some article properties. Rendering can also be done using `GitHub Actions`, but I chose to implement the rendering logic on the website service.

Reasons:
- I don't want to generate excessive content in the repository.
- Online rendering combined with caching performs well.
- Keeping the rendering logic alongside the website code helps maintain consistency and makes it easier to maintain.

Rendering is implemented around the `Remark` library, with simplified rendering code:

```ts filename=app/lib/md.server.ts
async function createProcessor() {
  const highlighter = (await createHighlighterCore({
    // ...
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  })) as HighlighterGeneric<any, any>;
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeShiki, highlighter, {
      // Highlight options
    })
    .use(() => {
      // Add copy button for each <pre>
    })
    .use(rehypeRaw)
    .use(rehypeSlug)
    .use(() => {
      // Collect TOC as <nav>...</nav>
    })
    .use(rehypeAutolinkHeadings)
    .use(rehypeStringify);
}

// ...

export async function markdownToHtml(markdown: string) {
  const { body } = fm<Record<string, string>>(markdown);
  const processor = await requireProcessor();
  const file = await processor.process({
    path: "/markdown.md",
    cwd: "",
    value: body,
  });
  const content = String(file);
  const navEndIndex = content.indexOf("</nav>");
  const navInnerHtml = content.slice(5, navEndIndex);
  const navList = navInnerHtml ? navInnerHtml.split("<br>") : [];
  const contentHtml = content.slice(navEndIndex + 6);
  return {
    navList,
    html: contentHtml,
  };
}
```

## `i18n` Support

Supporting `i18n` in Remix is not difficult; however, it’s important to note that unlike `SPA` applications, `SSR` applications need to render `i18n` on the server as well as on the client.

### Client and Server `i18n` Initialization

```ts filename=app/lib/i18n/init.client.ts lines=[2]
export async function clientInitI18n() {
  use(BackendHttp);
  use(initReactI18next);
  return init({
    ...defaultInitOptions,
    backend: {
      loadPath: "/locales/{{lng}}.json",
    },
  });
}
```

```ts filename=app/lib/i18n/init.server.ts lines=[23]
async function loadLangResource(lang: string) {
  const ret = await import(`../../../public/locales/${lang}.json`);
  return ret.default;
}

class Backend {
  static type = "backend";

  init(
    _services: Services,
    _backendOptions: object,
    _i18nextOptions: InitOptions
  ): void {}

  read(language: string, _namespace: string, callback: ReadCallback): void {
    loadLangResource(language).then((resource) => {
      callback(null, resource);
    });
  }
}

export async function serverInitI18n(lang: string) {
  use(Backend as never);
  use(initReactI18next);
  return init({
    ...defaultInitOptions,
    lng: lang,
  });
}
```

The above are the `i18n` initialization codes for the client and server, with the difference lying in the `Backend`. The client fetches the corresponding translation resources via `HTTP requests`, while the server uses `import()` to lazily import the corresponding resource JSON files directly.

### Using in React Components

```tsx filename=app/root.tsx lines=[4,7,15,30]
export async function loader({ request }: LoaderFunctionArgs) {
  // ...
  if (!isI18nInitialized) {
    await serverInitI18n(lang); // Don't do this in entry.server.ts, which is fired after this loader
    isI18nInitialized = true;
  } else {
    await i18n.changeLanguage(lang);
  }
  return json(
    {
      // Shouldn't rely on loader to set lang. When url is changed (in SPA),
      // root loader won't be called, lang is not updated.
      colorScheme: cookies.colorScheme,
      cookies,
      i18nStore: i18next.store.data,
    },
    // ...
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { colorScheme, i18nStore } =
    useRouteLoaderData<typeof loader>("root") || {};
  if (typeof window !== "undefined") {
    configBaseUrl(window.location.href);
  }
  const location = useLocation();
  const { lang } = parseUrlPathLang(location.pathname);
  // Using i18n resource from loader to save network request
  useI18nLang(lang, i18nStore || {});
  // ...
  return (
    <html
      lang={lang}
      className={colorScheme == "dark" ? "dark" : undefined}
      dir={i18n.dir()}
    >
      { /*...*/ }
    </html>
  );
}
```

The `loader` executes on the server, and its memory state does not automatically synchronize with the client. The `Layout` executes on both the server and the client, allowing us to retrieve server data using `useLoaderData` or `useRouteLoaderData`, which are available on both the server and the client.
> If the loader in `root.tsx` returns successfully but an exception occurs afterward, `useLoaderData` cannot access the data, while `useRouteLoaderData` can, but it needs to check for null values.

In the `Layout`, besides parsing `location.pathname` to get the current language setting, the initial `i18n` resource state is reused for the client through the `i18nStore` returned by the `loader`, saving subsequent HTTP requests for the same language resources.

Next, you can use the `t` function in your React components.

```tsx
const { t } = useTranslation();
return <div>{t('Greetings')}</div>
```

> I do not directly use `react-i18next`'s `useTranslation` method. If you use this method without specifying a language, it often results in a `Hydration mismatch` error. This occurs because `useTranslation` defaults to using `i18next.language` as the current language, and when `i18next` loads another language (when a default language is specified), it sets the `language` attribute to that language. This causes the `language` to first change to *another language* and then switch back to *the current language*. For example, if the default language is `en`, but the current language according to the user settings is `zh`, the server renders as `zh`, while the client initially loads and renders as `en`, resulting in a `Hydration mismatch` problem.

A simple encapsulation of `import('react-i18next').useTranslation`:

```ts
export function useTranslation() {
  // Specify lng to avoid conflicts when loading other languages,
  // which will change i18n.language and cause hydration mismatch
  return _useTranslation(undefined, { lng: currentLang });
}
```

## Pitfalls Encountered 😭😭😭

- **Using Cloudflare Worker to Deploy the Site**

  My initial plan was to deploy the site using the `Cloudflare Worker` Free Plan, which led to several pitfalls:
  - You cannot directly use Node packages. If a dependency imports something like `import 'fs'`, that dependency cannot be used; you can use `import 'node:fs'`, but it’s just a Dumb Stub. The `Worker` does not support any APIs like `fs`; calls will result in errors because the `Worker` does not run on `Node` but rather on `V8`, offering limited support for `Node` APIs.
  - The free plan has a CPU quota of only `10ms` CPU time per request, resulting in frequent timeout errors when rendering blog content. Of course, the paid plan increases this to `50ms`, which should be sufficient.

    > `CPU time` refers to the actual CPU time spent excluding IO wait; for instance, `setTimeout(() => {}, 1000)` may have a CPU time of less than `1ms`. Generally, computational tasks require more CPU time, such as text parsing and rendering.

- **`loader` Executes Before `entry.server.ts`'s `handleRequest`.**
  
  Initially, I executed `i18n` initialization and other request initialization logic in `entry.server.ts`, only to find that `loader` and `entry` actually execute in parallel, with `loader` typically executing first.

- **Setting the Website BaseURL:**
  
  A fixed `BaseURL` configuration is difficult to use across various environments, especially when deploying to `Vercel`, which may have multiple domain names for different environments. It seems that dynamically setting the BaseURL based on requests would be a better choice.However, I soon encountered difficulties. First, the `Remix` application does not have a unified request entry point, especially when deployed on Vercel, which does not allow developers to set routing entry points; in contrast, `Worker` requires custom entry handling logic.

  Thus, I started to encounter issues:

  Setting the BaseURL in `Root.tsx`'s `loader` resulted in several errors later, with the cause being that the BaseURL was not set! 😰
  
  After debugging, I discovered that non-page routes like `xxx.ts` do not pass through the `Root Loader`. Even `xxx.tsx` page routes may not necessarily pass through the `Root Loader` 😭😭😭
  
  In SPA navigation mode, the page does not make full data requests, and at this point, page routes do not hit the `Root Loader`, only requesting the corresponding route's `loader` data.Therefore, we need to **set** the BaseURL in every `loader` of the pages that might use it.
  
  This is indeed quite troublesome; is there a way to optimize this? Yes, the answer is `Remix Middleware`, but unfortunately, it is [not yet released](https://github.com/remix-run/remix/discussions/7642).

- **Vercel Preview:**
  
  The preview mode requires authentication via Cookies, and as mentioned earlier regarding CDN caching, rendering article pages requires self-requesting the corresponding CDN cache route. If the request does not include Cookies, a 403 error will occur.
  
  So how can we obtain these Cookies? We can directly log the Cookies from the client’s requests to the server and pass those Cookies when requesting our own service.

  ```ts
  export async function loader({ request }: LoaderFunctionArgs) {
    // Save request
  }
  // ...
  export async function fetchCDNCache() {
    const requestContext = /* Get saved request */
    const res = await fetch(url, {
      headers: {
        Cookie: requestContext.headers.get('cookie');
      }
    })
  }
  ```

- **`i18n` Time Zone Issues:**
  
  If the time zones of the client and server are different, directly calling functions that need to format date and time based on the time zone will lead to `Hydration mismatch` errors.
  
  The correct approach should be to render time zone-related information entirely on the client (using `useEffect`), while the server either does not render or renders initial content that is not time zone-dependent.

- **Using Remix’s `<ScrollRestoration>` Component May Cause `#anchor` Jumps to Fail or Flashing Issues:**

  The solution is to use `<Link>` instead of `<a>` and specify `preventScrollReset`. For example:
  
  ```tsx
  <Link to={"#" + id} preventScrollReset></Link>
  ```
  
  If it is really impossible to directly use `<Link>`, then you need to listen for all `<a>`'s `onClick` events.

  ```tsx
  const navigate = useNavigate();
  useEffect(() => {
    const clickListener = (e: MouseEvent) => {
      const el = e.currentTarget as HTMLAnchorElement;
      const url = new URL(el.href);
      if (url.hash) {
        e.preventDefault();
        navigate(url.hash, { preventScrollReset: true });
      }
    };
    /* ... */
  }, [/* ... */]);
  ```

- **`useEffect` Event Listener for DOM Elements Fails During Route Navigation:**
  
  For example, in the above `useEffect`, when navigating to another route parameter set of **the same page**, `useEffect` **does not rebuild**, while the DOM tree has actually **rebuilt**. This means we have not created event listeners for the new DOM elements, leading to problems.

  The solution is to include `location.pathname` or other information containing **complete route parameters** in the `useEffect` dependency list:
  
  ```tsx lines=[13]
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    const clickListener = (e: MouseEvent) => {
      const el = e.currentTarget as HTMLAnchorElement;
      const url = new URL(el.href);
      if (url.hash) {
        e.preventDefault();
        navigate(url.hash, { preventScrollReset: true });
      }
    };
    /* ... */
  }, [navigate, location.pathname]);
  ```

  **All event listeners not managed by `React` should be aware of this issue!**
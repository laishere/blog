---
title: 基于Remix打造一个博客网站
---

最近在学[`Remix`](https://remix.run/)，也有自己写一个博客网站的想法，于是我就利用Remix技术搭建了这个博客网站。博客基于网站和内容分离的模式，将网站部署在 `Vercel`，并使用 `Github仓库` 作为数据库存储博客内容。

使用到的主要技术：`Remix`、`React`、`TailwindCSS`。

用于Markdown文件处理: `FrontMatter`、`Remark`、`Shiki`、`Rehype`。

由于UI比较简单，我并没有采用UI框架，而是选择自己编写所有UI。

## 架构

<img class="light" style="max-width:60%" src="https://i.ibb.co/wpjG0Ms/arch-light.png" alt="网站架构" />
<img class="dark" style="max-width:60%" src="https://i.ibb.co/sqMFCHs/arch-dark.png" alt="网站架构" />

如上图所示，Remix网站服务作为无状态组件为用户提供页面渲染功能。网站服务直接访问数据库，查询文章内容等数据。博客网站需要支持`SEO`(Search Engine Optimization)，通常使用`SSR`(Server-Side Rendering)或者`SSG`(Static-Site Generation)。

本站选择采用SSR模式。为什么？
- 我希望内容和网站分离。
- 更新内容的时候不用重新部署网站。

那么相比直接使用SSG，SSR的缺点是什么呢？
- 需要服务器，不能纯静态部署
- SSR更难被长期缓存，访问速度会受到影响

SSR也并非一无是处，事实上，很多网站依然采用SSR而不是SSG。比如著名的博客网站框架`WordPress`，它就是由`PHP`渲染的。
使用SSR不像SSG那样需要在每次修改内容后都重新部署，更适合经常更新的动态内容网站。

有人可能会说，现在CI/CD使用这么普遍，直接写个Workflow自动化部署不好吗？
- 重新部署整个网站耗时更长
- 重新部署可能导致缓存清除(比如使用Vercel作为部署方案)
- 不是所有人都懂技术，很多博客创作者只是单纯地进行内容创作

综上，使用SSR对于内容创作来说门槛更低，建站更容易，这可能也是为什么WordPress如今依然流行的原因吧？

除此之外，SSR的计算能力使得某些场景需求实现更加容易。例如：深色/浅色模式无缝支持。

配色切换在浏览器利用js也能直接支持，区别在哪呢？

仅使用浏览器端js进行配色方案切换的示例步骤：
1. 浏览器加载页面
2. js检查配色方案是否匹配
3. 不匹配则切换

这会有一个问题，假如浏览器加载的是浅色页面，那么步骤1后，用户会立马看见一个浅色页面，瞬间步骤2和3完成，用户又可能看到一个深色页面。中间会有个**闪屏**的现象。

而使用SSR则可以根据用户设置，通常是使用Cookies存储用户的配色偏好，然后在服务器上直接渲染，返回的页面就已经是最终配色，**不会有闪屏**的现象。

当然SSG通过某些手段也是可以实现这个效果的，比如：
- 在URL上直接存储配色参数
- 使用反向代理，根据Cookies信息自动转发到合适的URL，这隐藏了客户端的URL参数，更加美观，但也更复杂

上面的方案都需要SSG同时生成支持的所有配色方案，而且要么URL不够简洁，要么需要依赖服务器的配置，过于麻烦。

综上，选择SSR似乎也不是一个坏的选择，那么，选择了SSR，是否就意味着性能上一定不如SSG呢？

**不一定！** 如果我们可以更好地像SSG那样利用好缓存，那么我们其实可以得到一个很接近SSG的性能。

## 缓存✨

<img class="light" style="max-width:60%" src="https://i.ibb.co/YP7207v/cache-light.png" alt="缓存架构" />
<img class="dark" style="max-width:60%" src="https://i.ibb.co/Kzjv3J6/cache-dark.png" alt="缓存架构" />

简单来说，当内容没有发生改变时，我们希望直接利用缓存结果，当内容发生改变后，我们再重新渲染更新缓存。

### 内存/Redis缓存

缓存的选择和部署方案有关，如果部署在自己的服务器，那么大可以直接利用内存缓存和文件缓存。然而，我选择了部署在`Vercel`。

Vercel的方案是`Serverless`方案，文件缓存时指望不上了，那么我们可以用内存缓存吗？经过测试，答案是**可以**。但是，内存缓存并不保证持久，而且是本地缓存，只有当某个缓存key对应的缓存内容可以长期保证不变时，我们才能设置长期的本地缓存。因为当缓存内容可能经常改变，那么我们就需要有**可靠的缓存刷新手段**，显然分布式的Serverless很难刷新每个部署的本地缓存。

还有什么其它低延迟的中心化/同步缓存方案吗？有，那就是`Redis`等Key-Value数据库。对于需要及时更新的内容，我们可以使用`短期内存缓存` + `长期Redis缓存`的多级缓存方案。`内存缓存`虽然可能造成一定更新延迟，但可以减少`Redis缓存`的查询频率。

我写了一个简单的多级缓存逻辑：
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

Redis我是白嫖[Upstash](https://upstash.com/)，每天有*10K命令免费额度*。经过测试，同地域的读延迟大概在**50+ms**左右，有时会在几ms内，不是特别稳定。

在内存缓存没有击中的时候，我们就查询Redis缓存，**但是因为Redis缓存可能存在`MISS`的情况，如果我们干等，可能就得多耗50多ms去请求内容。**于是，我选择同时查询Redis和发起内容请求，然后选择**第一个成功**的响应。一般来说，因为Redis查询更快，如果Redis缓存击中，那么我们会直接使用Redis缓存。

对`Promise.race`进行简单封装：

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

除了内存和Redis缓存外，还可以利用其它什么缓存吗？*毕竟Redis免费额度也是有限的*🤣

### CDN缓存

本着能省则省的原则，在缓存大体积内容时，我们可以直接使用CDN缓存。CDN除了可以直接给客户端提供服务外，也可以通过**请求自身**的方式充当服务器的缓存容器。本站将需要缓存的内容作为独立接口，方便我们控制每个内容的缓存时间。

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

目前主要用于 `meta` (博客内容元数据)和 `post` (博客文章内容)的缓存。其中post的缓存过期时间是最久的，最长过期时间是 `86400 + 604800` 秒，即8天。

有人可能会问：诶，博客内容不是可能更新的吗？你怎么敢缓存这么久？—— 哦，一定是CDN提供了缓存清除 `Purge` 支持吧！

不对！我使用的是Vercel提供的 `Edge Caching`。根据[Vercel的文档](https://vercel.com/docs/edge-network/caching#cache-invalidation)：
> The cache is automatically purged upon a new deployment being created. 
If you ever need to invalidate Vercel's Edge Network cache, you can always re-deploy. 

意味着我们只能重新部署网站才能清除缓存。

好家伙，每次更新个文章还得重新部署网站，那么分离式设计不就白搞了吗？

当然不需要重新部署，只要我们保证文章 **_“不变”_**，不就行了吗？—— 文章虽然会更新，但是我们只要附加版本号，那么每个版本的文章就是不变的，这也是前端打包常用的 `hash` 版本手段。所以，每次文章内容更新的时候，我们就请求新的版本，版本信息就在URL上，CDN就会替我们请求并缓存新的文章版本啦！

那么这个版本信息存在哪里呢？文章的版本等信息都存在 `meta` 元数据里面，这也就是为什么给 `meta` 设置这么短的缓存时间。**`meta` 的更新延迟，就是文章的更新延迟。**

**总结，本站采用了 `内存` + `Redis` + `CDN` 多级缓存方案。同时借助版本划分的手段，将易于更新的内容划分为固定不变的版本，从而更容易在无法主动更新的缓存方案上使用。**

## `meta`预处理和内容查询

上面提到，文章版本需要从 `meta` 中获取，那么 `meta` 又是怎么得到呢？而网站服务又是怎么查询对应的文章内容的呢？

### `meta`预处理

`meta` 是所有文章的元数据，要得到这个元数据，要么人工编辑，要么自动生成。那肯定选择自动生成啊，准确又省时。

在文章开头提到，博客内容存放在 `Github仓库`，我们可以利用 `GitHub Actions` 在文章更新时自动生成 `meta`，同时向网站服务发起主动刷新缓存的请求。

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

上面的函数负责处理刷新缓存的操作，为了防止攻击，我在缓存清除操作中设置了密码校验。`purgePostsMetaCache` 函数负责清除 `meta` 的本地 `内存缓存` 和 `Redis缓存`。

### 文章内容查询

[GitHub REST API](https://docs.github.com/en/rest)提供了访问`Github仓库`的方法。这里我们使用到其中的 [Repositories/Contents](https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28#get-repository-content)。

为此，我们需要获取GitHub提供的凭据。凭据类型分为三种：`PAT(Personal Access Token)`, `GitHub Apps` 和 `GtiHub OAuth`。因为是私人用途，很自然地选择了`PAT`。生成`PAT`也很简单，到个人设置页面，选择Developer设置，选择生成最新出的 `Fine-Grained PAT` 即可。这个凭据提供了细粒度的权限控制，可以指定仅访问某些仓库的某些权限。

## 博客内容渲染

博客内容采用 `Markdown` 格式编写，同时使用 `Front Matter` 记录一些文章的属性。渲染当然也可以利用 `GitHub Actions` 完成，但是我选择了把渲染逻辑放在网站服务上。

理由：
- 我不想在仓库上生成过多内容
- 在线渲染结合缓存性能不差
- 和网站代码放在一起更利于渲染和网站保持一致性，更易于维护

渲染围绕 `Remark` 库实现，简化的渲染代码：

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

## `i18n`支持

在Remix中支持 `i18n` 并不难，需要注意的是，和 `SPA` 应用不一样，`SSR` 应用不仅需要在客户端渲染 `i18n`，也需要在服务器做类似的事情。

### 客户端和服务器`i18n`的初始化

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

上面分别是客户端和服务器的 `i18n` 初始化代码，区别在于 `Backend` 的不同。客户端通过 `HTTP请求` 获取对应的翻译资源。而服务器我直接使用 `import()` 延迟导入对应的资源JSON文件。

### 在React组件中使用

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

`loader` 是在服务器执行的，其内存状态不会自动同步给客户端。`Layout` 在服务器和客户端都执行，我们可以通过 `useLoaderData` 或者 `useRouteLoaderData` 获取服务器的数据，这些数据在服务器和客户端都可用。
> 如果root.tsx的loader成功返回，但是后面发生异常，`userLoaderData` 无法获取数据，而 `useRouteLoaderData` 则可以，但是需要检查是否为空。

在 `Layout` 中，除了通过解析 `location.pathname` 获取当前语言设置，还通过使用 `loader` 返回的 `i18nStore` 给客户端复用初始的 `i18n` 资源状态。节省了后续相同语言资源的HTTP请求。

接下来就可以在React组件中使用 `t` 函数了。

```tsx
const { t } = useTranslation();
return <div>{t('Greetings')}</div>
```

> 我并不是直接使用 `react-i18next` 的 `useTranslation` 方法。如果直接使用该方法而不指定语言，那么往往会发生 `Hydration mismatch` 错误。这是因为 `useTranslation` 默认是通过使用 `i18next.language` 作为当前语言的，而 `i18next` 在加载另一个语言时（指定默认语言时），会将 `language` 属性设置为那个语言。这就导致 `language` 会先变为*另一种语言*，然后再切换回*当前语言*。比如默认语言是 `en`，但是根据用户设置，当前语言如果是 `zh`，则服务器渲染的是 `zh`，而客户端会先加载并渲染 `en`，这就导致了 `Hydration mismatch` 问题。

对 `import('react-i18next').useTranslation` 的简单封装：

```ts
export function useTranslation() {
  // Specify lng to avoid conflicts when loading other languages,
  // which will change i18n.language and cause hydration mismatch
  return _useTranslation(undefined, { lng: currentLang });
}
```

## 踩过的坑😭😭😭

- **使用Cloudflare Worker部署本站**

  我一开始的计划是使用 `Cloudflare Worker` Free Plan 部署本站的。踩了不少坑：
  - 无法直接使用 `Node` 的包，如果依赖中直接使用类似 `import 'fs'` 的导入方式，那么这个依赖无法使用，可以使用 `import 'node:fs'`，
    但是仅仅是一个Dumb Stub。`Worker` 其实不支持任何诸如 `fs` 之类的API，调用只会报错，因为 `Worker` 并不是运行在 `Node` 上的，而是运行在 `V8`，对 `Node` API仅提供有限支持。
  - 免费计划的CPU额度只有每个请求 `10ms` CPU时间，结果实测在渲染博客内容的时候经常超时报错。当然付费计划可以上到 `50ms` 额度，应该是足够了。
    
    > `CPU时间` 指的是排除IO等待的实际CPU耗时，比如 `setTimeout(() => {}, 1000)` 的CPU耗时可能不足 `1ms`。一般计算型任务CPU耗时比较多，比如文本解析和渲染。

- **`loader` 比 `entry.server.ts` 的 `handleRequest` 更先执行。**
  
  一开始我在 `entry.server.ts` 中执行 `i18n` 初始化等请求初始化逻辑，后来发现 `loader` 和 `entry` 其实是并行执行的。`loader` 通常比 `entry` 更先执行。

- **网站BaseURL设置：**
  
  因为固定的 `BaseURL` 配置难以在各种环境中使用，尤其是当部署到 `Vercel` 可能有多个不同环境的域名。这样看来根据请求动态设置BaseURL会是更好的选择。但是很快我就遇到了困难，首先，`Remix` 应用不存在统一的请求入口，尤其是在Vercel中部署，Vercel不允许开发者设置路由入口，相比之下 `Worker` 倒是需要自己编写入口处理逻辑。
  
  于是我开始踩坑：

  在 `Root.tsx` 的 `loader` 中设置，结果后面遇到了不少错误，原因是BaseURL没有设置！😰
  
  经过调试后发现，`xxx.ts` 非页面路由不会走 `Root Loader`。而且就算是 `xxx.tsx` 页面路由也不一定会走 `Root Loader`😭😭😭
  
  在SPA导航模式下，页面不会全量请求数据，此时页面路由不走 `Root Loader`，仅会请求对应路由的 `loader` 数据。所以，我们需要在每一个可能用到BaseURL的页面 `loader` **都设置** BaseURL。
  
  这确实很烦，是否有办法优化呢？有办法，答案就是`Remix Middleware`，不过可惜的是，[当前还没有发布](https://github.com/remix-run/remix/discussions/7642)。

- **Vercel Preview:**
  
  Preview模式下需要通过Cookies鉴权，而正如上面介绍的CDN缓存，在渲染文章页面时，需要自请求对应的CDN缓存路由地址，如果不带上Cookies就会报错403。
  
  那么怎么得到这个Cookies呢？可以直接将客户端对服务端的请求Cookies记录下来，在请求自身的服务时传递这个Cookies即可。
  
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


- **`i18n` 时区问题：**
  
  如果客户端和服务端的时区不一样，如果我们直接调用需要根据时区格式化日期时间的函数，那么就会导致 `Hydration mismatch` 错误。
  
  正确的做法应该是完全由客户端渲染时区相关的信息(使用 `useEffect` )，服务端要么不渲染，或者都初始渲染为与时区无关的信息。

- **使用Remix提供的 `<ScrollRestoration>` 组件会导致 `#anchor` 跳转失效或者出现闪屏问题：**

  解决办法，使用 `<Link>` 代替 `<a>` 并指定 `preventScrollReset`，比如：
  
  ```tsx
  <Link to={"#" + id} preventScrollReset></Link>
  ```
  
  如果实在无法直接使用 `<Link>` 那么需要监听所有 `<a>` 的 `onClick` 事件:
  
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

- **`useEffect` 监听DOM元素事件在路由跳转时失效：**
  
  例如上面的 `useEffect`，当跳转到**本页面**的另一个路由参数集合时，`useEffect` **不会重新构建**，而DOM树其实已经**重建**了，这就导致我们没有为新的DOM元素创建事件监听器，就会出现问题。

  解决办法：在 `useEffect` 依赖列表中加入 `location.pathname` 或者其它包含**完整路由参数**的信息作为依赖：
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

  **所有不由 `React` 管理的事件监听器都应该注意这个问题！**

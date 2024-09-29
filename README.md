# My Blog Content

Only store the content and some scripts here. For website repository, please refer to [blog-website](https://github.com/laishere/blog-website).

## Setup

1. Clone template branch

    ```sh
    git clone -b template https://github.com/laishere/blog.git
    ```

2. Rename as your main branch

    ```sh
    git branch -M main
    ```

3. Install dependencies

    ```sh
    npm install
    ```

## Test locally

1. Write some posts like this repository
2. Generate the posts meta locally

    ```sh
    npm run dev
    ```

3. Update `VITE_LOCAL_CONTENT_DIR` in website project's `.env` and run the website locally

## Deploy

**Content**

1. Create a GitHub repository
2. Allow `write` permission for actions in repository settings
3. Push to remote
4. Check if the action is performed normally

**Website**
1. Generate a `PAT` for the website and set it in the website project `.env`
2. Deploy website

What's more, for purging cache of the website, please setup an environment variable for this repository: `PURGE_CACHE_URL=http://<YOUR-DOMAIN>/cache/purge/<YOUR-VITE_CACHE_PURGE_SECRET>`. You may want to set it in the local `.env` file and run `npm run dev` first to verify the URL is correct.


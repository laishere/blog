import assert from 'assert';
import chalk from 'chalk';
import fm from 'front-matter';
import fs from 'fs';
import { join } from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { unified } from 'unified';
import remarkParse from 'remark-parse';

const startTime = Date.now();

const warn = console.warn;
console.warn = (...data) => warn(chalk.yellow(...data));

const isProd = process.env.NODE_ENV === 'production';
if (!isProd) {
    dotenv.config();
}
const POSTS_DIR = join(process.cwd(), 'posts');
const META_DIR = join(process.cwd(), isProd ? '.meta' : '.meta.local');
const LANGUAGES = ['en', 'zh'];

const PURGE_CACHE_URL = process.env.PURGE_CACHE_URL;

const POST_INDEX_META_RULES = {
    image: 'url',
    order: 'number',
    publishDate: 'date?',
};

const POST_LANG_META_RULES = {
    title: 'string',
    description: 'string',
    image: 'url?',
    publishDate: 'date?',
};

const POST_META_RULES = {
    publishDate: 'date',
};

function mergeRules(src) {
    const dst = POST_META_RULES;
    function baseKey(key) {
        return key.endsWith('?') ? key.slice(0, -1) : key;
    }
    for (const key in src) {
        if (dst[key] !== undefined) {
            if (baseKey(dst[key]) !== baseKey(src[key])) {
                throw new Error(`Mismatched rule for ${key}: ${dst[key]} vs ${src[key]}`);
            }
            if (src[key].endsWith('?')) {
                continue;
            }
        }
        dst[key] = src[key];
    }
}

mergeRules(POST_INDEX_META_RULES);
mergeRules(POST_LANG_META_RULES);

function verifyMeta(metaName, meta, rules) {
    for (const key in rules) {
        let rule = rules[key];
        const value = meta[key];
        if (rule.endsWith('?')) {
            rule = rule.slice(0, -1);
            if (value === undefined) {
                continue;
            }
        }
        assert(value !== undefined, `${metaName}: Missing required field ${key}`);
        if (rule === 'string') {
            assert(typeof value === 'string', `${metaName}: Invalid string for ${key}='${value}'`);
            assert(value.trim() !== '', `${metaName}: Empty string for ${key}`);
        } else if (rule === 'url') {
            assert(typeof value === 'string', `${metaName}: Invalid URL for ${key}='${value}'`);
            assert(value.startsWith('http://') || value.startsWith('https://'), `${metaName}: Invalid URL for ${key}='${value}'`);
        } else if (rule === 'number') {
            assert(typeof value === 'number', `${metaName}: Invalid number for ${key}='${value}'`);
        } else if (rule === 'date') {
            assert(value instanceof Date, `${metaName}: Invalid date for ${key}='${value}'`);
        } else {
            throw new Error(`Unknown rule ${rule}`);
        }
    }
    for (const key in meta) {
        if (!(key in rules)) {
            console.warn(`${metaName}: Unknown field ${key}`);
        }
    }
}

function readFrontMatter(file) {
    const content = fs.readFileSync(file, 'utf8');
    return [fm(content).attributes, content];
}

const processor = unified().use(remarkParse);

function toPlainText(node) {
    if ('value' in node) {
        return node.value.replace(/\s+/g, ' ').trim();
    }
    if ('children' in node) {
        return node.children.map(toPlainText).join('');
    }
    assert(false, 'Unknown node type: ' + node.type);
}

function extractDescription(content) {
    const tree = processor.parse(content.slice(0, 500));
    const firstParagraph = tree.children.find(node => node.type === 'paragraph');
    return firstParagraph ? toPlainText(firstParagraph) : '';
}

async function generatePostsMeta() {
    const posts = fs.readdirSync(POSTS_DIR);
    const postsMeta = {};
    for (const post of posts) {
        console.log('Processing', post);
        const dir = join(POSTS_DIR, post);
        const stat = fs.statSync(dir);
        assert(stat.isDirectory(), `${dir} is not a directory`);
        const index = join(dir, 'index.md');
        assert(fs.existsSync(index), `${index} does not exist`);
        const [indexMeta] = readFrontMatter(index);
        verifyMeta(`${post}/index.md`, indexMeta, POST_INDEX_META_RULES);
        const langFiles = fs.readdirSync(dir);
        const langsMeta = {};
        for (const langFile of langFiles) {
            const lang = langFile.split('.')[0];
            if (lang === 'index') {
                continue;
            }
            assert(LANGUAGES.includes(lang), `${lang} is not a valid language`);
            const [langMeta, content] = readFrontMatter(join(dir, langFile));
            if (!langMeta.description) {
                langMeta.description = extractDescription(content);
            }
            verifyMeta(`${post}/${langFile}`, langMeta, POST_LANG_META_RULES);
            const postMeta = { ...indexMeta, ...langMeta };
            verifyMeta(`${post}/full`, postMeta, POST_META_RULES);
            langsMeta[lang] = {
                ...langMeta,
                md5: crypto.createHash('md5').update(JSON.stringify(postMeta)).update(content).digest('hex'),
            };
        }
        for (const lang of LANGUAGES) {
            if (!langsMeta[lang]) {
                console.warn(`Missing ${lang} translation for ${post}`);
            }
        }
        postsMeta[post] = {
            ...indexMeta,
            path: 'posts/' + post,
            langs: langsMeta,
        };
    }
    fs.mkdirSync(META_DIR, { recursive: true });
    fs.writeFileSync(join(META_DIR, 'posts.json'), JSON.stringify(postsMeta, null, 2));
    if (PURGE_CACHE_URL) {
        console.log('Purging cache...');
        try {
            const res = await fetch(PURGE_CACHE_URL, { method: 'POST' });
            if (!res.ok) {
                console.warn('Failed to purge cache:', res.statusText);
            }
        } catch (err) {
            console.warn('Failed to purge cache:', err);
        }
    }
    console.log(`Done in ${Date.now() - startTime}ms.`);
}

generatePostsMeta();

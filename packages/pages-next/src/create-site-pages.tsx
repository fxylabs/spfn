import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import type { ReactElement } from 'react';
import { loadSite } from '@spfn/pages/server';
import type { ContentSource } from '@spfn/pages/server';
import type { PageDoc, SiteContent } from '@spfn/pages';
import { DocLayout, LandingLayout, PostLayout, PostsIndexLayout } from './layouts';

export interface SitePagesOptions
{
    /** Builds the content source; called once per (re)load, so it may capture env config. */
    source: () => ContentSource;
    /** Seconds a loaded site stays fresh at runtime (default 60). A static build shares one load. */
    revalidate?: number;
}

export interface SiteRouteParams
{
    slug?: string[];
}

interface RouteProps
{
    params: Promise<SiteRouteParams>;
}

const POSTS_INDEX = '/posts';

/**
 * Everything an optional catch-all route (`app/[[...slug]]/page.tsx`) needs:
 *
 *     const site = createSitePages({ source: () => new FsContentSource('.') });
 *     export const generateStaticParams = site.generateStaticParams;
 *     export const generateMetadata = site.generateMetadata;
 *     export default site.Page;
 *
 * Raw HTML pages are not served here — `spfn-pages sync` materializes them (and
 * `public/` assets) into Next's public dir before the build.
 */
export function createSitePages(options: SitePagesOptions)
{
    const getSite = siteLoader(options);

    async function generateStaticParams(): Promise<SiteRouteParams[]>
    {
        const site = await getSite();

        return routableSlugs(site).map(slug => ({ slug: segments(slug) }));
    }

    async function generateMetadata({ params }: RouteProps): Promise<Metadata>
    {
        const site = await getSite();
        const slug = slugPath((await params).slug);

        return buildMetadata(site, findDoc(site, slug), slug);
    }

    async function Page({ params }: RouteProps): Promise<ReactElement>
    {
        const site = await getSite();
        const slug = slugPath((await params).slug);

        const doc = findDoc(site, slug);
        if (doc)
        {
            return renderDoc(site, doc);
        }
        if (slug === POSTS_INDEX)
        {
            return <PostsIndexLayout site={site} />;
        }

        notFound();
    }

    return { generateStaticParams, generateMetadata, Page, getSite };
}

function siteLoader({ source, revalidate = 60 }: SitePagesOptions): () => Promise<SiteContent>
{
    let cached: Promise<SiteContent> | null = null;
    let loadedAt = 0;

    return () =>
    {
        if (!cached || Date.now() - loadedAt > revalidate * 1000)
        {
            loadedAt = Date.now();
            const loading = loadSite(source());
            cached = loading;
            loading.catch(() =>
            {
                if (cached === loading)
                {
                    cached = null;
                }
            });
        }

        return cached;
    };
}

function routableSlugs(site: SiteContent): string[]
{
    const slugs = [...site.pages, ...site.posts, ...site.mounted].map(doc => doc.slug);
    if (site.posts.length > 0 && !slugs.includes(POSTS_INDEX))
    {
        slugs.push(POSTS_INDEX);
    }

    return slugs;
}

function segments(slug: string): string[]
{
    return slug === '/' ? [] : slug.slice(1).split('/');
}

function slugPath(slugSegments: string[] | undefined): string
{
    return `/${(slugSegments ?? []).join('/')}`;
}

function findDoc(site: SiteContent, slug: string): PageDoc | null
{
    return [...site.pages, ...site.posts, ...site.mounted].find(doc => doc.slug === slug) ?? null;
}

function renderDoc(site: SiteContent, doc: PageDoc): ReactElement
{
    switch (doc.frontmatter.layout)
    {
        case 'landing':
            return <LandingLayout site={site} page={doc} />;
        case 'post':
            return <PostLayout site={site} page={doc} />;
        default:
            return <DocLayout site={site} page={doc} />;
    }
}

function buildMetadata(site: SiteContent, doc: PageDoc | null, slug: string): Metadata
{
    const name = site.config.name;
    if (!doc)
    {
        return slug === POSTS_INDEX ? { title: `Posts — ${name}`, ...siteMetadata(site) } : {};
    }

    const title = doc.slug === '/' ? name : `${doc.frontmatter.title} — ${name}`;
    const description = doc.frontmatter.description ?? site.config.description;
    const ogImage = doc.frontmatter.og ? `/${doc.frontmatter.og}` : site.ogImage;

    // canonical/og:url are slugs resolved against metadataBase — emitted only when `url` provides it
    return {
        title,
        description,
        ...siteMetadata(site),
        ...(site.config.url ? { alternates: { canonical: doc.slug } } : {}),
        openGraph: {
            title,
            description,
            siteName: name,
            ...(site.config.url ? { url: doc.slug } : {}),
            ...(site.config.locale ? { locale: site.config.locale } : {}),
            ...(ogImage ? { images: [ogImage] } : {}),
        },
    };
}

/** Site-wide metadata: favicon and the base URL that makes og:image absolute. */
function siteMetadata(site: SiteContent): Metadata
{
    return {
        ...(site.config.url ? { metadataBase: new URL(site.config.url) } : {}),
        ...(site.favicon ? { icons: { icon: [{ url: site.favicon, type: iconMimeType(site.favicon) }] } } : {}),
    };
}

function iconMimeType(path: string): string
{
    const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    const types: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

    return types[extension] ?? 'image/x-icon';
}

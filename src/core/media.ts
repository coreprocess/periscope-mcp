const TEXT_EXTENSIONS =
    /\.(txt|log|csv|tsv|json|ndjson|jsonl|md|xml|ya?ml|html?|sql|ini|cfg|conf|properties|ts|js|py|java|cs|sh)$/i;

/** Whether content is text, by its media type or, failing that, the extension of its name. */
export const isTextual = (contentType: string, name: string): boolean =>
    /^text\//.test(contentType) ||
    /(json|xml|yaml|csv|x-ndjson|javascript|sql)/.test(contentType) ||
    TEXT_EXTENSIONS.test(name);

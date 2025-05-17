export default {
  async fetch(request, env, ctx) {
    async function fetchAndParseJson(url, sourceDescription) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15-second timeout for each fetch

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'PortainerTemplatesWorker/1.2 (github.com/YOUR_USERNAME/YOUR_REPO_NAME; +https://your-worker-url.workers.dev)', // Customize with your details
            'Accept': 'application/json, text/plain;q=0.9', // Prefer JSON, accept plain text to inspect errors
          }
        });
        clearTimeout(timeoutId); // Clear timeout if fetch completes in time

        if (!response.ok) {
          console.error(`Failed to fetch <span class="math-inline">\{sourceDescription\} \(</span>{url}): HTTP ${response.status} ${response.statusText}`);
          return { error: `HTTP ${response.status} ${response.statusText}`, url, status: response.status };
        }

        const contentType = response.headers.get("content-type");
        const responseText = await response.text(); // Get text first to inspect before parsing

        // Check if content is JSON, even if server sends 200 OK, it might be an HTML error page.
        if (contentType && contentType.toLowerCase().includes("application/json")) {
            if (responseText.trim().startsWith("<")) {
                 console.warn(`Workspaceed <span class="math-inline">\{sourceDescription\} \(</span>{url}) with Content-Type JSON, but content appears to be HTML. This might be a Cloudflare block page or similar.`);
                 // Fallback to treating as non-JSON if it looks like HTML
            } else {
                try {
                    return JSON.parse(responseText); // Attempt to parse as JSON
                } catch (e_json) {
                    console.error(`Error parsing JSON from <span class="math-inline">\{sourceDescription\} \(</span>{url}): <span class="math-inline">\{e\_json\.message\}\. Response text \(first 150 chars\)\: '</span>{responseText.substring(0,150)}'`);
                    return { error: `JSON Parse Error: ${e_json.message}`, url, content_snippet: responseText.substring(0,150) };
                }
            }
        }

        // If not application/json or was HTML disguised as JSON
        console.warn(`Workspaceed <span class="math-inline">\{sourceDescription\} \(</span>{url}), but Content-Type is not application/json (is: ${contentType || 'N/A'}). Or content was HTML.`);
        return { error: `Invalid content-type: ${contentType || 'N/A'} or content was HTML.`, url, content_snippet: responseText.substring(0,150) };

      } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') {
            console.error(`Timeout fetching <span class="math-inline">\{sourceDescription\} \(</span>{url}) after 15 seconds.`);
            return { error: 'Fetch timeout after 15 seconds', url };
        }
        console.error(`Network or other error fetching <span class="math-inline">\{sourceDescription\} \(</span>{url}): ${e.message}`);
        return { error: e.message, url };
      }
    }

    // Start with an empty array or a minimal, reliable base template.
    let aggregatedTemplates = [];
    // Example of a minimal built-in template (optional, can be removed if all templates should come from URLs)
    /*
    aggregatedTemplates.push({
        "type": 1, "title": "Minimal Nginx (Worker Built-in)", "name": "nginx-minimal-worker",
        "description": "A minimal Nginx server, included directly in the worker.",
        "categories": ["Web"], "platform": "linux", "logo": "https://raw.githubusercontent.com/portainer/templates/master/logos/nginx.png",
        "image": "nginx:alpine", "ports": ["8080:80/tcp"], "restart_policy": "unless-stopped",
        "note": "Access via http://[HOST_IP]:8080. This is a sample template from the worker itself."
    });
    */

    const failedSources = [];
    const successfulSources = [];

    const requestUrl = new URL(request.url);
    const qTemplatesB64 = requestUrl.searchParams.get("templates");
    let userProvidedTemplateUrls = [];

    if (qTemplatesB64) {
      try {
        const decodedJsonString = atob(qTemplatesB64); // Base64 decode
        const parsedUserUrls = JSON.parse(decodedJsonString); // Parse as JSON
        if (Array.isArray(parsedUserUrls) && parsedUserUrls.every(item => typeof item === 'string' && (item.startsWith('http://') || item.startsWith('https://')))) {
          userProvidedTemplateUrls = parsedUserUrls;
        } else {
          console.warn("Decoded 'templates' query parameter is not an array of valid HTTP/HTTPS URLs.");
          failedSources.push({url: "query_parameter_templates", reason: "Decoded 'templates' query parameter is not an array of valid HTTP/HTTPS URLs."});
        }
      } catch (e) {
        console.error("Error decoding/parsing 'templates' from query string:", e.message);
        failedSources.push({url: "query_parameter_templates", reason: `Error decoding/parsing: ${e.message}`});
      }
    }

    // Define your default list of template URLs here.
    // Prioritise official Portainer templates and well-maintained lists.
    // CURATE THIS LIST: Verify each URL. Remove any that are problematic or unmaintained.
    const defaultTemplateProviderURLs = [
      "https://raw.githubusercontent.com/portainer/templates/master/templatesV2.json", // Official Portainer V2 templates
      "https://raw.githubusercontent.com/Lissy93/portainer-templates/main/templates.json",
      // "https://raw.githubusercontent.com/xneo1/portainer_templates/master/Template/template.json", // User reported issues with 'Tabby' in this one
      "https://raw.githubusercontent.com/Qballjos/portainer_templates/master/Template/template.json",
      // "https://raw.githubusercontent.com/technorabilia/portainer-templates/main/lsio/templates/templates-2.0.json", // May contain V1 format, can cause issues
      "https://raw.githubusercontent.com/SelfhostedPro/selfhosted_templates/portainer-2.0/Template/template.json",
      // The following were mentioned in the user's original context; evaluate their quality and format before uncommenting.
      // "https://raw.githubusercontent.com/TheLustriVA/portainer-templates-Nov-2022-collection/main/templates_2_2_rc_2_2.json",
      // "https://raw.githubusercontent.com/ntv-one/portainer/main/template.json",
      // "https://raw.githubusercontent.com/mycroftwilde/portainer_templates/master/Template/template.json",
      // "https://raw.githubusercontent.com/mikestraney/portainer-templates/master/templates.json",
      // "https://raw.githubusercontent.com/dnburgess/self-hosted-template/master/template.json",
      // "https://raw.githubusercontent.com/mediadepot/templates/master/portainer.json"
      // Known problematic URL removed: "https://raw.githubusercontent.com/OliverCullimore/portainer-templates/master/templates.json",
    ];

    const allTemplateUrlsToFetch = [...new Set([...userProvidedTemplateUrls, ...defaultTemplateProviderURLs])];

    for (const tURL of allTemplateUrlsToFetch) {
      if (!tURL || typeof tURL !== 'string' || (!tURL.startsWith('http://') && !tURL.startsWith('https://'))) {
        console.warn(`Skipping invalid or non-HTTP/S URL: ${tURL}`);
        failedSources.push({ url: String(tURL || "undefined_or_invalid_url"), reason: "Invalid URL format or type" });
        continue;
      }

      console.log(`Workspaceing templates from: ${tURL}`);
      const result = await fetchAndParseJson(tURL, `source: ${tURL}`);

      if (result.error) {
        failedSources.push({ url: tURL, reason: result.error, status: result.status, content_snippet: result.content_snippet });
      } else {
        let templatesFromSource = [];
        let sourceDescriptionForLog = `from ${tURL}`;

        if (result.templates && Array.isArray(result.templates)) { // Standard Portainer V2 structure: {version, templates: []}
          templatesFromSource = result.templates;
          sourceDescriptionForLog += " (found in result.templates)";
        } else if (Array.isArray(result)) { // Root is an array of templates
          templatesFromSource = result;
          sourceDescriptionForLog += " (root is an array)";
        } else if (typeof result === 'object' && result !== null) { // Other possible structures
            if (result.version && result.stacks && Array.isArray(result.stacks)) { // Common V1 "stacks" structure
                templatesFromSource = result.stacks.map(stack => ({ ...stack, type: stack.type || 2, title: stack.title || stack.name || "Untitled Stack" }));
                sourceDescriptionForLog += " (converted from result.stacks)";
            } else if (result.title && (result.image || (result.repository && result.repository.url))) { // A single template object at the root
                templatesFromSource = [result];
                sourceDescriptionForLog += " (single template object at root)";
            } else { // Heuristic: look for any array property that looks like templates
                let found = false;
                for (const key in result) {
                    if (Array.isArray(result[key]) && result[key].length > 0 &&
                        result[key][0].title && (result[key][0].image || (result[key][0].repository && result[key][0].repository.url))) {
                        templatesFromSource = result[key];
                        sourceDescriptionForLog += ` (found in nested array result.${key})`;
                        found = true;
                        break;
                    }
                }
                if (!found) sourceDescriptionForLog += " (unknown structure)";
            }
        }

        console.log(`Processing ${templatesFromSource.length} potential templates ${sourceDescriptionForLog}`);
        let countValidTemplatesInSource = 0;
        for (const t of templatesFromSource) {
          // Rigorous V2 template validation (must have title, type, and image or stackfile repo)
          if (t && typeof t.title === 'string' && t.title.trim() !== '' &&
              (typeof t.type === 'number' && [1, 2, 3].includes(t.type)) && // Type 1 (container), 2 (swarm stack), 3 (compose stack)
              ( (typeof t.image === 'string' && t.image.trim() !== '') || // For type 1
                (t.repository && typeof t.repository.url === 'string' && t.repository.url.trim() !== '' &&
                 typeof t.repository.stackfile === 'string' && t.repository.stackfile.trim() !== '') // For type 2 & 3
              )
             ) {
            aggregatedTemplates.push(t);
            countValidTemplatesInSource++;
          } else {
            console.warn(`Skipping malformed/incomplete template from <span class="math-inline">\{tURL\}\. Title\: '</span>{String(t.title || "N/A").substring(0,50)}', Type: '${t.type || "N/A"}'. Check structure/required fields.`);
          }
        }

        if (countValidTemplatesInSource > 0) {
            successfulSources.push(tURL);
        } else if (!result.error) { // Successfully fetched and parsed, but no valid templates found
            failedSources.push({ url: tURL, reason: "No valid V2 templates extracted from source structure.", content_snippet: JSON.stringify(result).substring(0,150) });
        }
      }
    }

    // De-duplicate templates based on title (case-insensitive)
    const uniqueTemplates = [];
    const titlesEncountered = new Set();
    for (const t of aggregatedTemplates) {
        if (t.title && typeof t.title === 'string') { // Ensure title exists and is a string
            const lowerCaseTitle = t.title.toLowerCase();
            if (!titlesEncountered.has(lowerCaseTitle)) {
                uniqueTemplates.push(t);
                titlesEncountered.add(lowerCaseTitle);
            }
        } else {
            console.warn("Template found without a valid title, it will be excluded from de-duplication and final list if not fixed.", JSON.stringify(t).substring(0,100));
        }
    }

    // Sort templates alphabetically by title
    uniqueTemplates.sort((a, b) => (a.title || "").localeCompare(b.title || ""));

    const finalJsonResponse = {
      version: "2", // Portainer expects template schema version 2
      templates: uniqueTemplates,
    };

    const response = new Response(JSON.stringify(finalJsonResponse), {
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        "Access-Control-Allow-Origin": "*", // Allow cross-origin requests from any domain (Portainer)
        "Cache-Control": "s-maxage=3600, stale-while-revalidate=600" // Cache on CDN for 1 hour, serve stale for 10 mins while revalidating
      },
    });

    // Add diagnostic headers (limit size for headers)
    response.headers.append('X-Worker-Processed-Templates-Count', uniqueTemplates.length.toString());
    response.headers.append('X-Worker-Successful-Sources-Count', successfulSources.length.toString());
    response.headers.append('X-Worker-Failed-Sources-Count', failedSources.length.toString());
    // Truncate lists if too long for headers
    const MAX_HEADER_LIST_LENGTH = 5;
    response.headers.append('X-Worker-Successful-Sources-List', JSON.stringify(successfulSources.slice(0, MAX_HEADER_LIST_LENGTH)));
    response.headers.append('X-Worker-Failed-Sources-List', JSON.stringify(failedSources.map(f => ({url: f.url, reason: String(f.reason).substring(0,100)})).slice(0, MAX_HEADER_LIST_LENGTH)));

    return response;
  },
};

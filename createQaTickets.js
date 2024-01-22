/**
 * This script is used to automate the process of creating quality assessment (QA) tickets in Zendesk.
 * It retrieves articles from all non-excluded brands, then creates tickets for QA assessment for each article's author
 * oAuthToken requires scopes {read, ticket:write, impersonate}
 * 
 * Current Conditions for QA Assessment 
 *  - Article's content was last updated in the current calendar month
 *  - Article's author is not a user excluded from QA assessment in config.nameExclusions
 *  - Article has not already been assigned a QA ticket in the current calendar month
 *      - This is done by retrieving tickets with the tag 'qa_{month}_{year}' (set on ticket creation in this script), then checking if the "Quality Assessment: {Article Title}" is the subject
 * 
 * Important Notes
 *  - Currently treats articles last updated by a content block edit as if they were last updated by the API user
 *  - If the script errors trying to get the author, it will set the author to the API user
 *  - Both instances of API User above are treated as different authors and will both be included in ticket creation step
 */

var config = {
    oAuthToken: '', //oAuthToken requires scopes {read, ticket:write, impersonate}
    subdomain: '', //subdomain of the Zendesk instance. Help center subdomain is retrieved from brand object when ran 
    ticketCountPerEditor: 2,
    apiUserId: 0, //ID of the API user. Tickets will be created on behalf of this user

    relativePotentialQaRange: {
        type: 'months', //must be 'months', 'weeks', or 'days'
        value: 1 //number of months, weeks, or days to go back to find articles to QA. 0 = current calendar month, 1 = previous calendar month, etc.
    },

    staticTicketInfo: {
        brand_id: 0, //set brand assignment
        ticket_form_id: 0,
        priority: "normal",
        group_id: 0, //set group assignment
    },

    exclusions: {
        // set by string "name"
        name: [
            "Permanently deleted user",
            "API User",
            "Content Block Edit"
        ],
        // set by numeric "id". each id set here will be skipped 
        brand: [
            0,
            1
        ]
    },
    //originally used these to test the script, but I left them in in case it's useful in the future
    readOnly: false, //If true, the script will log the tickets it would have created without actually creating them
    extraLogging: false //If true, the script will log more information about the process
};

//Configure ticket to be created per QA article here. Static info taken from config.staticTicketInfo, dynamic info passed in from article info
function buildQaTicket(articleTitle, articleHtmlUrl, articleAuthId) {
    return {
        "ticket": {
            ...config.staticTicketInfo,
            requester_id: articleAuthId,
            subject: `Quality Assessment: ${articleTitle}`,
            comment: {
                html_body: `<p><a href="${articleHtmlUrl}">${articleTitle}</a><br><br>This article has been selected for quality assessment on ${dateInfo.currentDateString}</p>`,
                public: false,
                author_id: config.apiUserId
            },
            custom_fields: [
                {
                    id: "",
                    value: ""
                }
            ],
            tags: [
                dateInfo.monthYearString
            ]
        }
    }
}
//set conditons for articles to be considered for QA here.
function checkQaConditions(authorName, updatedAt, oldestEditTime, articleTitle) {
    return (
        !config.exclusions.name.includes(authorName)
        && (updatedAt > oldestEditTime)
        && (!recentlyQAdTickets || recentlyQAdTickets.some(ticket => ticket.subject == 'Quality Assessment: ' + articleTitle)) //checks if the article has already been QA'd this month using global recentlyQAdTickets (which contains tickets with tag indicating already QA'd this month)  
    );
}

async function getRecentlyQAdTickets() {
    sendReq(`https://${config.subdomain}.zendesk.com/api/v2/search.json?query=type:ticket%20tags:${dateInfo.monthYearString}`, 'GET', config.oAuthToken).then(res => {
        return res.results
    })
}

//gets the calendar month and year, and the epoch time for the cutoff date for QA assessment
function getDateInfo() {
    var date = new Date();
    var year = date.getFullYear();
    var month = date.getMonth();
    var day = date.getDate();
    var calendarMonth = new Date(year, month, 1, 0, 0, 0, 0);
    var cutoffDate = new Date(year, month, day, 0, 0, 0, 0)

    //set cutoff date based on config.relativePotentialQaRange
    switch (config.relativePotentialQaRange.type) {
        case 'months':
            cutoffDate.setMonth(month - config.relativePotentialQaRange.value);
            cutoffDate.setDate(1)
            break;
        case 'weeks':
            cutoffDate.setDate(day - (subtractAmountconfig.relativePotentialQaRange.value * 7));
            break;
        case 'days':
            cutoffDate.setDate(day - subtractAmountconfig.relativePotentialQaRange.value)
            break;
        default:
            console.error('Invalid Type Set in config.relativePotentialQaRange. Must be "month", "week", or "day"');
            return;
    }

    return {
        currentDateString: date.toLocaleString('default', {
            day: 'numeric',
            month: 'short',
            year: 'numeric'
        }),
        monthYearString: 'qa_' + calendarMonth.toLocaleString('default', {
            month: 'short',
            year: 'numeric'
        }).replace(/ /g, '_').toLowerCase(),
        editCutoffEpochTime: getEpochTime(cutoffDate)
    };
}

async function sendReq(url, method, oAuthToken, body, onBehalfOf) {
    try {
        let req = {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + oAuthToken,
            }
        }
        if (onBehalfOf) {
            req.headers['X-On-Behalf-Of'] = onBehalfOf
        }
        if (body) {
            req["body"] = JSON.stringify(body)
        }
        return fetch(url, req)
            .then(res => {
                if (res.status === 429) {
                    // Rate limit reached, wait for the specified duration and retry the request
                    const retryAfter = parseInt(res.headers.get('Retry-After')) || 1;
                    return new Promise(resolve => setTimeout(resolve, retryAfter * 1000))
                        .then(() => sendReq(url, method, oAuthToken, body));
                } else if (!res.ok) {
                    throw new Error(`HTTP error! Status: ${res.status}`);
                }
                return res.json();
            });
    } catch (error) {
        console.error('error: ', error);
    }
}

async function getBrands() {
    let response = await sendReq(`https://${config.subdomain}.zendesk.com/api/v2/brands`, 'GET', config.oAuthToken);
    return response.brands;
}

function getEpochTime(date) {
    return new Date(date).getTime() / 1000;
}

//next_page link returned by the API doesn't work, so this function fixes it. Possible zendesk bug?
function fixNextPageLink(nextPage) {
    let corrections = {
        'incremental': 'help_center/incremental',
        'hc/': '',
        '%2C': ','
    }

    for (let correction in corrections) {
        nextPage = nextPage.replace(correction, corrections[correction]);
    }

    return nextPage;
}

// Retrieves articles for a specific brand and stores them in the 'potentialQaArticles' object.
async function getBrandArticles(link, brandName, potentialQaArticles) {
    try {
        var res = await sendReq(link, 'GET', config.oAuthToken)
        for (let article of res.articles) {
            let translation = article.translations[0]
            let author = getAuthor(res.users, translation);
            if (checkQaConditions(author.name, getEpochTime(translation.updated_at), dateInfo.editCutoffEpochTime, translation.title)) {
                if (!potentialQaArticles[author.name]) {
                    potentialQaArticles[author.name] = []
                }
                potentialQaArticles[author.name].push({
                    'articleAuthId': author.id,
                    'articleTitle': translation.title,
                    'articleUpdatedAt': translation.updated_at,
                    'articleHtmlUrl': translation.html_url
                });
            }
        }
        if (res.next_page) {
            let nextPage = fixNextPageLink(res.next_page)
            logLong(nextPage)
            await getBrandArticles(nextPage, brandName, potentialQaArticles)
        }
    } catch (error) {
        //console.error('Error getting articles for brand:', error);
    }
    return;
}

//Gets the author name and id from the users array in the response. If the author is not found, it returns the API user id with name "Error getting author name" or "Content Block Edit"
function getAuthor(users, translation) {
    //I'm not sure why the try block doesn't catch the error when setting object properties (author.name), but it doesn't. This sets 2 variables independently and returns them as object
    let authorName;
    let id;
    if (translation.updated_by_id == -1) {
        authorName = "Content Block Edit";
        id = config.apiUserId
    } else {
        try {
            authorName = users.find(user => user.id === translation.updated_by_id).name
            id = translation.updated_by_id;
        } catch (error) {
            authorName = "Error getting author name";
            id = config.apiUserId
        }
    }
    return { 'name': authorName, 'id': id };
}

async function getQAArticles() {
    var potentialQaArticles = {};
    let brands = await getBrands();
    for (let brand of brands) {
        if (brand.active && !config.exclusions.brand.includes(brand.id)) {
            let brandName = brand.name;
            //link includes start_time parameter to only get articles updated after the start of the calendar month and includes users and translations
            let link = `https://${brand.subdomain}.zendesk.com/api/v2/help_center/incremental/articles.json?include=users,translations&start_time=${dateInfo.editCutoffEpochTime}`
            console.log((`Getting articles for brand: ${brandName} -\n ${link}`))

            await getBrandArticles(link, brandName, potentialQaArticles)
        }
    }
    return potentialQaArticles
}

var dateInfo;
try {
    dateInfo = getDateInfo();
} catch (error) {
    console.error("Error getting date info:", error);
    return; // Stop running if there's an error getting the date info
}
var recentlyQAdTickets = await getRecentlyQAdTickets();

//used for debugging
function logLong(message) {
    if (config.extraLogging) {
        console.log(message)
    }
}
getQAArticles().then(potentialQaArticles => {
    console.log('Potential QA Articles - ', potentialQaArticles);
    let ticketPromises = [];
    var ticketsMadePerEditor = {};
    for (let editor in potentialQaArticles) {
        logLong(editor)
        if (!ticketsMadePerEditor[editor]) {
            ticketsMadePerEditor[editor] = []
        }
        let editorArticleCount = potentialQaArticles[editor].length
        let qaArticles = []

        if (editorArticleCount > config.ticketCountPerEditor) {
            //get random articles from the editor's articles
            for (var i = 0; i < config.ticketCountPerEditor; i++) {
                let randomIndex = Math.floor(Math.random() * editorArticleCount)
                logLong({ 'Random Index': randomIndex, 'Potential QA Articles': potentialQaArticles[editor] })
                qaArticles.push(potentialQaArticles[editor].splice(randomIndex - 1, 1)[0])
                logLong({ 'Article Chosen': potentialQaArticles[editor][randomIndex], 'Chosen Ones': qaArticles })
            }
        } else {
            qaArticles = potentialQaArticles[editor]
        }

        for (let article of qaArticles) {
            logLong({ 'Processing': article })

            if (!article) {
                logLong({ qaArticles: qaArticles, potentialQaArticles: potentialQaArticles[editor] })
                break;
            }

            //create ticket body then send request
            let ticketBody = buildQaTicket(article.articleTitle, article.articleHtmlUrl, article.articleAuthId);

            if (!config.readOnly) {
                ticketPromises.push(
                    sendReq(`https://${config.subdomain}.zendesk.com/api/v2/tickets.json`, 'POST', config.oAuthToken, ticketBody, config.apiUserId).then(res => {
                        ticketsMadePerEditor[editor].push({ ticketId: res.ticket.id, articleTitle: article.articleTitle });
                    })
                );
            } else {
                ticketsMadePerEditor[editor].push({ ticketId: 'read only', articleTitle: article.articleTitle });
            }
        }
    }
    Promise.all(ticketPromises).then(() => {
        console.log('Tickets Created - ', ticketsMadePerEditor)
    });
})

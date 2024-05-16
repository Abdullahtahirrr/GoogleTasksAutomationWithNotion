const { google } = require('googleapis');
const express = require('express');
const { Client } = require('@notionhq/client');
const app = express();
require('dotenv').config();

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const notionDatabaseId = process.env.NOTION_DATABASE_ID;

let tokens;
//Get Authorization URL
app.get('/auth/google', (req, res) => {
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/tasks'],
    });
    res.redirect(authUrl);
});

//Handle Callback & Get Tokens
app.get('/oauth2callback', async (req, res) => {
    const code = req.query.code;

    try {
        const { tokens: newTokens } = await oauth2Client.getToken(code);
        tokens = newTokens;
        oauth2Client.setCredentials(tokens);
        console.log('Tokens acquired:', tokens);
        res.send('Authentication successful!');
    } catch (error) {
        console.error('Error during OAuth callback:', error);
        res.status(500).send('Authentication failed');
    }
});

//Function to fetch task lists and their tasks
async function getTaskListsAndTasks() {
    const service = google.tasks({ version: 'v1', auth: oauth2Client });
    const response = await service.tasklists.list();
    const taskLists = response.data.items;

    // Fetch tasks for each task list
    const tasksPromises = taskLists.map(async (taskList) => {
        const tasksResponse = await service.tasks.list({ tasklist: taskList.id });
        return {
            ...taskList,
            tasks: tasksResponse.data.items || [],
        };
    });

    return await Promise.all(tasksPromises);
}

// Function to fetch tasks from Notion
async function fetchTasksFromNotion() {
    try {
        const response = await notion.databases.query({
            database_id: notionDatabaseId,
        });
        console.log(response.results);
        return response.results;
    } catch (error) {
        console.error('Error fetching tasks from Notion:', error);
        return [];
    }
}

// Function to determine if a task is new
function isNewTask(task, notionTasks) {
    return !notionTasks.some(notionTask => notionTask.properties['Name'].title[0].text.content === task.title);
}

// Function to save new tasks to Notion
async function saveNewTasksToNotion(taskListsWithTasks, notionTasks) {
    for (const taskList of taskListsWithTasks) {
        for (const task of taskList.tasks) {
            if (isNewTask(task, notionTasks)) {
                const properties = {
                    'Name': {
                        title: [
                            {
                                text: {
                                    content: task.title,
                                },
                            },
                        ],
                    },
                    'TaskList': {
                        rich_text: [
                            {
                                text: {
                                    content: taskList.title,
                                },
                            },
                        ],
                    },
                    'Status': {
                        select: {
                            name: task.status === 'completed' ? 'Completed' : 'Not Started',
                        },
                    },
                };

                if (task.due) {
                    properties['Due Date'] = {
                        date: {
                            start: task.due,
                        },
                    };
                }

                try {
                    await notion.pages.create({
                        parent: { database_id: notionDatabaseId },
                        properties: properties,
                    });
                } catch (error) {
                    console.error('Error saving task to Notion:', error);
                }
            }
        }
    }
}

// Function to delete tasks from Notion that are not present in Google Tasks
async function deleteTasksFromNotion(taskListsWithTasks, notionTasks) {
    for (const notionTask of notionTasks) {
        if (!taskListsWithTasks.some(taskList => taskList.tasks.some(task => task.title === notionTask.properties['Name'].title[0].text.content))) {
            // Task is not present in Google Tasks, delete it from Notion
            try {
                await notion.pages.update({
                    page_id: notionTask.id,
                    archived: true, // Archive the task
                });
                console.log('Task deleted from Notion:', notionTask.properties['Name'].title[0].text.content);
            } catch (error) {
                console.error('Error deleting task from Notion:', error);
            }
        }
    }
}

// Function to update tasks' status in Notion if changed in Google Tasks
async function updateTaskStatusInNotion(taskListsWithTasks, notionTasks) {
    for (const taskList of taskListsWithTasks) {
        for (const task of taskList.tasks) {
            const notionTask = notionTasks.find(notionTask => notionTask.properties['Name'].title[0].text.content === task.title);
            if (notionTask && notionTask.properties['Status'].select.name !== (task.status === 'completed' ? 'Completed' : 'Not Started')) {
                try {
                    await notion.pages.update({
                        page_id: notionTask.id,
                        properties: {
                            'Status': {
                                select: {
                                    name: task.status === 'completed' ? 'Completed' : 'Not Started',
                                },
                            },
                        },
                    });
                    console.log('Task status updated in Notion:', task.title);
                } catch (error) {
                    console.error('Error updating task status in Notion:', error);
                }
            }
        }
    }
}

// Function to fetch, compare, save tasks, and update task status
async function fetchCompareAndSaveTasks() {
    try {
        const [taskListsWithTasks, notionTasks] = await Promise.all([
            getTaskListsAndTasks(),
            fetchTasksFromNotion(),
        ]);

        console.log('Task Lists and their Tasks:', JSON.stringify(taskListsWithTasks, null, 2));

        await saveNewTasksToNotion(taskListsWithTasks, notionTasks);
        await deleteTasksFromNotion(taskListsWithTasks, notionTasks);
        await updateTaskStatusInNotion(taskListsWithTasks, notionTasks);
    } catch (error) {
        console.error('Error fetching, comparing, and saving tasks:', error.message);
    }
}

app.listen(3000, () => {
    console.log('App listening on port 3000');
    // Periodically fetch task lists and their tasks every 10 seconds
    setInterval(fetchCompareAndSaveTasks, 10000);
});

// Search the saved chats of every registered project.
import { requireToken } from '../auth.mjs';
import { searchChats } from '../chat-search.mjs';
import { searchQuery } from './history.mjs';

export const routes = [
  { method: 'GET', path: '/api/history/search-all', handler: searchAllRoute },
];

async function searchAllRoute({ req, url, res, json, store, httpError }) {
  requireToken(req, httpError);
  const q = searchQuery(url, httpError);
  const state = store.get();
  return json(res, 200, searchChats(state, state.projects ?? [], q));
}

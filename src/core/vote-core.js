const {knex} = require('../util/database').connect();
import {hotScore} from './score-core';

function createOrUpdateVote(opts) {
  const updateVoteSql = `
    WITH upsert AS
      (UPDATE votes SET value = ? WHERE user_id = ? AND feed_item_id = ? RETURNING *)
      INSERT INTO votes (value, user_id, feed_item_id)
      SELECT ?, ?, ? WHERE NOT EXISTS (SELECT * FROM upsert)
  `;

  const selectVotesSql = `
    SELECT
      feed_items.id as id,
      vote_score(feed_items) as votes,
      EXTRACT (EPOCH FROM feed_items.created_at) as age
    FROM feed_items
    WHERE feed_items.id = ?
    GROUP BY feed_items.id
  `;

  const updateFeedItemSql = `
    UPDATE feed_items
    SET hot_score = ?
    WHERE id = ?
  `;

  const updateVoteParams = [opts.value, opts.client.id, opts.feedItemId,
    opts.value, opts.client.id, opts.feedItemId];

  return knex.transaction(function(trx) {
    return trx.raw(updateVoteSql, updateVoteParams)
      .then(result => trx.raw(selectVotesSql, [opts.feedItemId]))
      .then(result =>
        trx.raw(updateFeedItemSql, [
            hotScore(
              result.rows[0]['votes'],
              result.rows[0]['age']
            ),
            opts.feedItemId,
          ])
      )
      .then(result => undefined)
      .catch(err => {
        let error = new Error('No such feed item id: ' + opts.feedItemId);
        error.status = 404;
        throw error;
      });
  });
}

export {
  createOrUpdateVote
};

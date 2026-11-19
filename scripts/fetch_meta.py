#!/usr/bin/env python3
"""Pulls the four Openhouse ad accounts' numbers from Meta's Marketing API into one data file.

    META_TOKEN=... python3 scripts/fetch_meta.py --out data/snapshot.json

META_TOKEN is a system-user token with ads_read on the ad accounts below. The data file holds,
for each period the dashboard offers (today ... all time), the totals of every campaign, ad set
and ad that ran, plus each campaign's spend per day for the charts, and the names, audiences
and ad text the tables show. It never holds the token.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

GRAPH = 'https://graph.facebook.com/' + os.environ.get('GRAPH_VERSION', 'v24.0')
ACCOUNTS = {
    '428357117849129': 'Openhouse 2',
    '605518854162850': 'Openhouse Temp',
    '324083576441691': 'Openhouse Backup',
    '1643698160129047': 'Openhouse - 4',
}
IST = ZoneInfo('Asia/Kolkata')
PRESETS = ['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'this_month', 'last_month', 'all_time']
TOKEN = os.environ.get('META_TOKEN', '').strip()


def log(*parts):
    print(*parts, file=sys.stderr, flush=True)


# ---- Talking to Meta ----

def call(path, params=None, method='GET', tries=6):
    """One Graph API request. Paging links from Meta are followed as they are."""
    if path.startswith('https://'):
        url, data = path, None
    else:
        query = dict(params or {})
        query['access_token'] = TOKEN
        url = GRAPH + '/' + path.lstrip('/')
        data = None
        if method == 'GET':
            url += '?' + urllib.parse.urlencode(query)
        else:
            data = urllib.parse.urlencode(query).encode()
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, data=data, method=method)
            with urllib.request.urlopen(req, timeout=180) as res:
                return json.load(res)
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode('utf-8', 'replace')).get('error', {})
            except ValueError:
                err = {}
            transient = err.get('is_transient') or err.get('code') in (1, 2, 4, 17, 32, 341, 613, 80000, 80004) or e.code >= 500
            if transient and attempt < tries - 1:
                time.sleep(min(90, 5 * 2 ** attempt))
                continue
            # The message never includes the URL, which carries the token.
            raise RuntimeError('Meta refused %s: %s (code %s)' % (path.split('?')[0][:80], err.get('message', 'HTTP %s' % e.code), err.get('code')))
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt < tries - 1:
                time.sleep(min(90, 5 * 2 ** attempt))
                continue
            raise


def pages(path, params):
    page = call(path, params)
    while True:
        for row in page.get('data', []):
            yield row
        nxt = (page.get('paging') or {}).get('next')
        if not nxt:
            return
        page = call(nxt)


def insights(account, params, label):
    """Runs an insights report as a background job on Meta's side: big date ranges don't time out."""
    body = {'use_unified_attribution_setting': 'true', 'limit': 500}
    body.update(params)
    run = call('act_%s/insights' % account, body, method='POST')['report_run_id']
    started = time.time()
    while True:
        status = call(run, {'fields': 'async_status,async_percent_completion'})
        if status.get('async_status') == 'Job Completed':
            break
        if status.get('async_status') in ('Job Failed', 'Job Skipped'):
            raise RuntimeError('Meta could not finish the %s report for %s.' % (label, ACCOUNTS[account]))
        if time.time() - started > 1200:
            raise RuntimeError('Meta took over 20 minutes on the %s report for %s.' % (label, ACCOUNTS[account]))
        time.sleep(4)
    rows = list(pages('%s/insights' % run, {'limit': 500}))
    log('  %-16s %-26s %6d rows' % (ACCOUNTS[account], label, len(rows)))
    return rows


def by_ids(ids, fields):
    """Reads objects by ID, 50 at a time. An ID Meta no longer serves is skipped."""
    out = {}
    ids = sorted(set(i for i in ids if i))

    def read(batch):
        try:
            got = call('', {'ids': ','.join(batch), 'fields': fields})
            out.update({k: v for k, v in got.items() if isinstance(v, dict)})
        except RuntimeError:
            if len(batch) > 1:
                half = len(batch) // 2
                read(batch[:half])
                read(batch[half:])

    batches = [ids[i:i + 50] for i in range(0, len(ids), 50)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(read, batches))
    return out


# ---- Shaping Meta's answers ----

def periods(today):
    month_start = today.replace(day=1)
    last_month_end = month_start - timedelta(days=1)
    day = timedelta(days=1)
    return {
        'today': (today, today),
        'yesterday': (today - day, today - day),
        'last_7d': (today - 6 * day, today),
        'last_14d': (today - 13 * day, today),
        'last_30d': (today - 29 * day, today),
        'this_month': (month_start, today),
        'last_month': (last_month_end.replace(day=1), last_month_end),
        # Meta keeps 37 months of results; the dashboard's "all time" starts on the 1st of the month three years back.
        'all_time': (date(today.year - 3, today.month, 1), today),
    }


def num(value, kind=float):
    try:
        return kind(float(value))
    except (TypeError, ValueError):
        return 0


def action(row, name):
    for a in row.get('actions') or []:
        if a.get('action_type') == name:
            return num(a.get('value'), int)
    return 0


def measures(row):
    return [round(num(row.get('spend')), 2), num(row.get('impressions'), int), num(row.get('reach'), int) if 'reach' in row else None,
            action(row, 'link_click'), action(row, 'lead'), action(row, 'omni_purchase')]


def slim_targeting(t):
    """Keeps the parts of an ad set's targeting the dashboard turns into its audience line."""
    if not isinstance(t, dict):
        return None
    # Meta mixes shapes here (lists of objects, of IDs, or single values), so only named objects are kept.
    items = lambda v: [x for x in v if isinstance(x, dict)] if isinstance(v, list) else []
    out = {k: t[k] for k in ('genders', 'age_min', 'age_max', 'age_range', 'facebook_positions', 'instagram_positions') if k in t}
    geo = t.get('geo_locations') if isinstance(t.get('geo_locations'), dict) else {}
    g = {}
    for k in ('custom_locations', 'places'):
        if items(geo.get(k)):
            g[k] = [{'name': x.get('name'), 'radius': x.get('radius'), 'distance_unit': x.get('distance_unit')} for x in items(geo.get(k))]
    for k in ('cities', 'regions'):
        if items(geo.get(k)):
            g[k] = [{'name': x.get('name')} for x in items(geo.get(k))]
    if isinstance(geo.get('countries'), list) and geo['countries']:
        g['countries'] = geo['countries']
    if g:
        out['geo_locations'] = g
    for k in ('custom_audiences', 'excluded_custom_audiences'):
        if items(t.get(k)):
            out[k] = [{kk: x[kk] for kk in ('name', 'subtype', 'lookalike_spec') if kk in x} for x in items(t.get(k))]
    groups = [grp for grp in t.get('flexible_spec') or [] if isinstance(grp, dict)] if isinstance(t.get('flexible_spec'), list) else []
    if groups:
        out['flexible_spec'] = [{k: [{'name': x.get('name')} for x in items(v)] for k, v in grp.items() if items(v)} for grp in groups]
    auto = t.get('targeting_automation')
    if isinstance(auto, dict) and 'advantage_audience' in auto:
        out['targeting_automation'] = {'advantage_audience': auto['advantage_audience']}
    return out


def creative_text(c):
    """Headline, primary text, button and carousel cards, wherever this kind of creative keeps them."""
    obj = lambda v: v if isinstance(v, dict) else {}
    spec = obj(c.get('object_story_spec'))
    link = obj(spec.get('link_data'))
    video = obj(spec.get('video_data'))
    feed = obj(c.get('asset_feed_spec'))
    first = lambda v: obj(v[0]).get('text') if isinstance(v, list) and v else None
    ctas = feed.get('call_to_action_types') if isinstance(feed.get('call_to_action_types'), list) else []
    cta = c.get('call_to_action_type') or obj(link.get('call_to_action')).get('type') or obj(video.get('call_to_action')).get('type') \
        or (ctas[0] if ctas else None)
    return {
        'object_type': c.get('object_type'),
        'title': c.get('title') or link.get('name') or video.get('title') or first(feed.get('titles')),
        'body': c.get('body') or link.get('message') or video.get('message') or first(feed.get('bodies')),
        'call_to_action_type': cta,
        'effective_object_story_id': c.get('effective_object_story_id'),
        'video_id': c.get('video_id') or video.get('video_id'),
        'child_attachments': [{'name': k.get('name')} for k in link.get('child_attachments') or [] if isinstance(k, dict)],
    }


def athome_sheet():
    """The At-Home bookings, from a published CSV of the sheet's non-personal columns (ATHOME_SHEET_CSV_URL):
    Booking ref, Booked at, Status, Subject, Plan, Total, utm_source, utm_medium, utm_campaign.
    Shaped like the Google Sheets answer the dashboard page reads. Without the URL the page shows Meta's count."""
    url = os.environ.get('ATHOME_SHEET_CSV_URL', '').strip()
    if not url:
        return None
    import csv
    import io
    with urllib.request.urlopen(url, timeout=60) as res:
        rows = list(csv.reader(io.StringIO(res.read().decode('utf-8'))))
    if not rows or len(rows[0]) < 9:
        raise RuntimeError('The At-Home sheet feed needs 9 columns: booking columns A-F, then utm_source, utm_medium, utm_campaign.')
    cell = lambda v: {'formattedValue': v}
    line = lambda values: {'values': [cell(v) for v in values]} if any(values) else {}
    log('  At-Home sheet     %d bookings' % (len(rows) - 1))
    return {'content': {'sheets': [{'data': [
        {'rowData': [line(r[:6]) for r in rows]},
        {'startColumn': 23, 'rowData': [line(r[6:9]) for r in rows]},
    ]}]}}


# ---- The pull ----

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', default='data/snapshot.json')
    out_path = parser.parse_args().out
    if not TOKEN:
        sys.exit('Set META_TOKEN to a token with ads_read on the Openhouse ad accounts.')

    now = datetime.now(timezone.utc)
    today = now.astimezone(IST).date()
    dates = periods(today)
    log('Pulling Meta numbers up to %s (India time)' % today)

    jobs = []
    for account in ACCOUNTS:
        for level, fields in (('campaign', 'campaign_id,campaign_name,spend,impressions,reach,actions'),
                              ('adset', 'adset_id,adset_name,campaign_id,spend,impressions,reach,actions'),
                              ('ad', 'ad_id,ad_name,adset_id,campaign_id,spend,impressions,reach,actions')):
            for preset in PRESETS:
                since, until = dates[preset]
                jobs.append((account, level, preset, {'level': level, 'fields': fields,
                                                      'time_range': json.dumps({'since': since.isoformat(), 'until': until.isoformat()})}))
        since, until = dates['all_time']
        jobs.append((account, 'campaign', 'days', {'level': 'campaign', 'fields': 'campaign_id,spend,impressions,actions', 'time_increment': 1,
                                                    'time_range': json.dumps({'since': since.isoformat(), 'until': until.isoformat()})}))

    def run(job):
        account, level, preset, params = job
        return job, insights(account, params, level + ' ' + preset)

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(run, jobs))

    totals = {level: {p: [] for p in PRESETS} for level in ('campaign', 'adset', 'ad')}
    names = {'campaign': {}, 'adset': {}, 'ad': {}}
    parent = {}  # ad set or ad -> its campaign, ad -> its ad set
    owner = {}   # campaign -> account
    campaign_days = []
    for (account, level, preset, _), rows in results:
        for r in rows:
            cid = r.get('campaign_id')
            if cid:
                owner[cid] = account
            if preset == 'days':
                m = measures(r)
                if any(m[i] for i in (0, 1, 3, 4, 5)):
                    campaign_days.append([cid, r.get('date_start'), m[0], m[1], m[3], m[4], m[5]])
                continue
            oid = r.get(level + '_id')
            if not oid:
                continue
            names[level][oid] = r.get(level + '_name')
            if level == 'adset':
                parent[oid] = {'c': cid}
            elif level == 'ad':
                parent[oid] = {'c': cid, 'as': r.get('adset_id')}
            totals[level][preset].append([oid] + measures(r))

    # ---- Names, statuses, audiences and ad text ----
    statuses = json.dumps(['ACTIVE', 'PAUSED', 'ARCHIVED', 'IN_PROCESS', 'WITH_ISSUES'])
    campaigns = {}
    for account in ACCOUNTS:
        for c in pages('act_%s/campaigns' % account, {'fields': 'id,name,objective,start_time,effective_status', 'effective_status': statuses, 'limit': 500}):
            campaigns[c['id']] = {'a': account, 'n': c.get('name'), 'o': c.get('objective'), 's': c.get('start_time'), 'st': c.get('effective_status')}
    missing = [cid for cid in owner if cid not in campaigns]
    for cid, c in by_ids(missing, 'id,name,objective,start_time,effective_status,account_id').items():
        campaigns[cid] = {'a': owner.get(cid) or c.get('account_id'), 'n': c.get('name'), 'o': c.get('objective'), 's': c.get('start_time'), 'st': c.get('effective_status')}
    for cid in owner:
        campaigns.setdefault(cid, {'a': owner[cid], 'n': names['campaign'].get(cid) or cid, 'o': None, 's': None, 'st': None})
    log('  %d campaigns' % len(campaigns))

    adsets = {}
    got = by_ids(names['adset'].keys(), 'id,name,campaign_id,effective_status,optimization_goal,targeting')
    for sid, name in names['adset'].items():
        a = got.get(sid, {})
        t = slim_targeting(a.get('targeting'))
        adsets[sid] = {'c': a.get('campaign_id') or parent[sid]['c'], 'n': a.get('name') or name, 'st': a.get('effective_status'),
                       'g': a.get('optimization_goal'), 't': json.dumps(t, separators=(',', ':')) if t else None}
    log('  %d ad sets' % len(adsets))

    ads = {}
    got = by_ids(names['ad'].keys(), 'id,name,adset_id,campaign_id,effective_status,creative{id}')
    for aid, name in names['ad'].items():
        a = got.get(aid, {})
        ads[aid] = {'c': a.get('campaign_id') or parent[aid]['c'], 'as': a.get('adset_id') or parent[aid]['as'], 'n': a.get('name') or name,
                    'cr': (a.get('creative') or {}).get('id'), 'st': a.get('effective_status')}
    log('  %d ads' % len(ads))

    creatives = {cid: creative_text(c) for cid, c in by_ids([a['cr'] for a in ads.values()],
                 'id,object_type,title,body,call_to_action_type,effective_object_story_id,video_id,object_story_spec,asset_feed_spec').items()}
    log('  %d creatives' % len(creatives))

    # ---- Account totals per day and per month, for the overview chart ----
    account_days, account_months = {}, {}
    for cid, day, spend, impressions, clicks, leads, purchases in campaign_days:
        account = campaigns.get(cid, {}).get('a') or owner.get(cid)
        for table, key in ((account_days, day), (account_months, day[:7])):
            row = table.setdefault(account, {}).setdefault(key, [key, 0, 0, 0, 0, 0])
            row[1] = round(row[1] + spend, 2)
            row[2] += impressions
            row[3] += clicks
            row[4] += leads
            row[5] += purchases
    campaign_days.sort(key=lambda r: (r[1], r[0]))

    snapshot = {
        'version': 1,
        'source': 'Meta Marketing API',
        'generated_at': now.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'today': today.isoformat(),
        'coverage': {'days_since': dates['all_time'][0].isoformat(), 'drill_complete_from': None},
        'accounts': ACCOUNTS,
        'campaigns': campaigns,
        'adsets': adsets,
        'ads': ads,
        'creatives': creatives,
        'totals': totals,
        'campaign_days': campaign_days,
        'account_days': {a: sorted(v.values()) for a, v in account_days.items()},
        'account_months': {a: sorted(v.values()) for a, v in account_months.items()},
    }
    sheet = athome_sheet()
    if sheet:
        snapshot['athome_sheet'] = sheet
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, 'w') as f:
        json.dump(snapshot, f, separators=(',', ':'))
    log('Wrote %s (%d KB)' % (out_path, os.path.getsize(out_path) // 1024))


if __name__ == '__main__':
    main()

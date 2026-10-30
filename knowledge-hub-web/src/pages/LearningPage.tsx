import React, { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useSearchParams } from 'react-router-dom';
import { DataNotice } from '../components/DataNotice';
import { api } from '../services/api';
import { describeApiError, requireApiData } from '../services/apiError';
import type { LearningEvidence, LearningQuestionView, LearningTopicProgress } from '../types/learning';

type OpenQuestion = Extract<LearningQuestionView, { blocked: false }>;
const when = (value: string): string => new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const dayLabel = (value: string): string => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'Europe/London' });

const TopicHistory: React.FC<{ topic: string; onReview: (session: string, position: number) => void }> = ({ topic, onReview }) => {
  const history = useInfiniteQuery({
    queryKey: ['learning-topic-history', topic], initialPageParam: 0,
    queryFn: async ({ pageParam }) => requireApiData(await api.learningTopicHistory(topic, pageParam)),
    getNextPageParam: (last, pages) => last.hasMore ? pages.length * 20 : undefined, retry: false,
  });
  return <div className="kh-learning__topic-history">
    {history.isPending && <p role="status">Loading topic history...</p>}
    {history.isError && <DataNotice title="Topic history could not be loaded" error={history.error} onRetry={() => { void history.refetch(); }} busy={history.isFetching} />}
    {!history.isPending && !history.isError && !history.data?.pages[0]?.answers.length && <p>No answers recorded for this topic yet.</p>}
    <ol>{history.data?.pages.flatMap(page => page.answers).map(answer => <li key={`${answer.sessionId}-${answer.position}`}>
      <div className="kh-learning__history-heading"><strong>{answer.correct ? 'Correct' : 'Incorrect'}</strong>
        <time dateTime={answer.answeredAt}>{when(answer.answeredAt)}</time></div>
      <p>{answer.question}</p><p className="kh-learning__meta">{answer.category} · {answer.level}{answer.withdrawn ? ' · Question subsequently withdrawn; historical result retained' : ''}</p>
      <p>Your answer: {answer.chosenAnswer}</p>
      {!answer.correct && <p>Correct answer: {answer.correctAnswer}</p>}
      <button type="button" className="kh-btn-ghost" onClick={() => { onReview(answer.sessionId, answer.position); }}>Review answer</button>
    </li>)}</ol>
    {history.hasNextPage && <button className="kh-btn-ghost" type="button" disabled={history.isFetchingNextPage}
      onClick={() => { void history.fetchNextPage(); }}>{history.isFetchingNextPage ? 'Loading...' : 'Load earlier answers'}</button>}
  </div>;
};
const TopicProgress: React.FC<{ topics: LearningTopicProgress[]; onReview: (session: string, position: number) => void }> = ({ topics, onReview }) => {
  const [expanded, setExpanded] = useState<string | null>(null);
  return <section className="kh-learning__progress" aria-label="Topic progress">
    <h2>Topic progress</h2>
    <p className="kh-learning__meta">Lifetime scores retain your answer history. Tailoring uses the latest ten answers per topic, starting after three source-valid answers.
      New tests use six focused questions and four for breadth once weaker topics emerge.</p>
    <div className="kh-learning__table-wrap"><table className="kh-learning__table">
      <caption className="kh-learning__sr-only">Your lifetime and recent learning scores by topic</caption>
      <thead><tr><th scope="col">Topic</th><th scope="col">Lifetime</th><th scope="col">Latest ten</th><th scope="col">Practice</th><th scope="col">History</th></tr></thead>
      <tbody>{topics.map(topic => <React.Fragment key={topic.id}><tr>
        <th scope="row">{topic.label}<span className="kh-learning__meta">{topic.ecosystem}</span></th>
        <td>{topic.answered ? `${topic.correct}/${topic.answered} · ${topic.accuracy}%` : 'Not started'}</td>
        <td>{topic.recentAnswered ? `${topic.recentCorrect}/${topic.recentAnswered} · ${topic.recentAccuracy}%` : '—'}</td>
        <td>{topic.recentAnswered < 3 ? `Building history (${topic.recentAnswered}/3)` : topic.recentAccuracy! < 100 ? 'Focused practice' : 'Maintain breadth'}</td>
        <td><button type="button" className="kh-btn-ghost" aria-expanded={expanded === topic.id} aria-controls={`learning-history-${topic.id}`}
          onClick={() => { setExpanded(current => current === topic.id ? null : topic.id); }}>{expanded === topic.id ? 'Hide' : 'View'}</button></td>
      </tr>{expanded === topic.id && <tr><td colSpan={5} id={`learning-history-${topic.id}`}>
        <TopicHistory topic={topic.id} onReview={onReview} />
      </td></tr>}</React.Fragment>)}</tbody>
    </table></div>
  </section>;
};

const Evidence: React.FC<{ refs: LearningEvidence[]; question: OpenQuestion }> = ({ refs, question }) => (
  <details className="kh-learning__evidence"><summary>Supporting official evidence</summary>
    {refs.map((ref, index) => <blockquote key={`${ref.source}-${index}`}>
      <p>{ref.quote}</p><cite><a href={question.sources[ref.source]?.url} target="_blank" rel="noreferrer">
        {question.sources[ref.source]?.title ?? 'Official documentation'}</a></cite>
    </blockquote>)}
  </details>
);

const LearningQuestion: React.FC<{ sessionId: string; position: number; questionCount: number; onNext: () => void }> = ({ sessionId, position, questionCount, onNext }) => {
  const cache = useQueryClient();
  const [chosen, setChosen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [report, setReport] = useState('');
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const discussion = useRef<HTMLTextAreaElement>(null);
  const query = useQuery({
    queryKey: ['learning-question', sessionId, position],
    queryFn: async () => requireApiData(await api.learningQuestion(sessionId, position)),
    retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: true,
  });
  const q = query.isFetching ? undefined : query.data;
  const open = q && !q.blocked ? q : undefined;
  useEffect(() => { if (discussionOpen) discussion.current?.focus(); }, [discussionOpen]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); }
    catch (err) { setError(describeApiError(err)); }
    finally { setBusy(false); }
  };
  const refresh = async (): Promise<void> => {
    await Promise.all([cache.invalidateQueries({ queryKey: ['learning-session', sessionId] }),
      cache.invalidateQueries({ queryKey: ['learning-overview'] }), query.refetch()]);
    await cache.invalidateQueries({ queryKey: ['learning-topic-history'] });
  };
  return <section className="kh-learning__question" aria-label={`Question ${position + 1}`} aria-busy={busy || query.isFetching}>
    <p className="kh-learning__meta">Question {position + 1} of {questionCount}</p>
    {query.isFetching && <p role="status">Checking the current official documentation before showing this question...</p>}
    {query.isError && <DataNotice title="The question could not be checked" error={query.error} onRetry={() => { void query.refetch(); }} busy={query.isFetching} />}
    {q?.blocked && <div className="kh-learning__withheld" role="status"><h2>Question withheld</h2><p>{q.reason}</p>
      <div className="kh-learning__actions">
        <button type="button" className="kh-btn-ghost" disabled={busy} onClick={() => { void query.refetch(); }}>Retry source check</button>
        <button type="button" className="kh-btn-accent" disabled={busy || q.chosen !== null} onClick={() => { void run(async () => {
          requireApiData(await api.prepareLearning(sessionId)); await refresh();
        }); }}>Prepare replacement questions</button>
      </div>
    </div>}
    {open && <>
      <p className="kh-learning__meta">{open.ecosystem} · {open.category} · {open.level}</p>
      <h2>{open.question}</h2>
      <form onSubmit={event => { event.preventDefault(); if (chosen === null) return; void run(async () => {
        requireApiData(await api.learningAnswer(sessionId, position, chosen)); await refresh();
      }); }}>
        <fieldset className="kh-learning__choices" disabled={busy || open.chosen !== null || open.skipped}>
          <legend className="kh-learning__legend">Choose one answer</legend>
          {open.options.map((option, index) => <label key={index} className={`kh-learning__choice${open.review?.correct === index ? ' kh-learning__choice--correct' : ''}${open.review && open.chosen === index && open.review.correct !== index ? ' kh-learning__choice--incorrect' : ''}`}>
            <input type="radio" name={`learning-${sessionId}-${position}`} value={index} checked={(open.chosen ?? chosen) === index}
              onChange={() => { setChosen(index); }} />
            <span>{option}</span>
            {open.review?.correct === index && <strong>Correct answer</strong>}
            {open.review && open.chosen === index && open.review.correct !== index && <strong>Your answer</strong>}
          </label>)}
        </fieldset>
        {!open.review && !open.skipped && <button className="kh-btn-accent" type="submit" disabled={busy || chosen === null}>
          {busy ? 'Checking and saving...' : 'Check answer'}</button>}
      </form>
      {open.skipped && !open.review && <p>This question was skipped.</p>}
      {open.review && <section className="kh-learning__review" aria-label="Answer explanation">
        <h3>{open.chosen === open.review.correct ? 'Correct' : 'Not quite'}</h3>
        <p>{open.review.explanation}</p><Evidence refs={open.review.evidence} question={open} />
        <h3>Why each answer does or does not fit</h3>
        <ul className="kh-learning__option-reviews">{open.review.options.map((option, index) => <li key={index}>
          <strong>{open.options[index]}</strong><p>{option.explanation}</p><Evidence refs={option.evidence} question={open} />
        </li>)}</ul>
        <button type="button" className="kh-btn-accent" aria-expanded={discussionOpen} disabled={busy}
          onClick={() => { setDiscussionOpen(value => !value); }}>Ask the learning agent</button>
        {discussionOpen && <section className="kh-learning__discussion" aria-label="Learning agent discussion">
          <h3>Explore the explanation with Athena</h3>
          <p>Answers use this question's official documentation. If it does not support an answer, Athena will say so.</p>
          <div className="kh-learning__messages" aria-live="polite">
            {open.messages.map(message => <article key={message.id}>
              <h4>You</h4><p>{message.question}</p><h4>Athena · learning agent</h4><p>{message.answer}</p>
              {message.evidence.length > 0 && <Evidence refs={message.evidence} question={open} />}
              <p className="kh-learning__meta">Sources checked {when(message.checkedAt)}</p>
            </article>)}
          </div>
          <form onSubmit={event => { event.preventDefault(); void run(async () => {
            requireApiData(await api.learningDiscuss(sessionId, position, prompt)); setPrompt(''); await refresh();
          }); }}>
            <label className="kh-uc-field"><span className="kh-uc-field__label">What would you like to understand?</span>
              <textarea ref={discussion} className="kh-uc-input kh-uc-input--area" rows={3} maxLength={2000}
                value={prompt} disabled={busy} onChange={event => { setPrompt(event.target.value); }} /></label>
            <button type="submit" className="kh-btn-accent" disabled={busy || !prompt.trim()}>{busy ? 'Checking the evidence...' : 'Ask Athena'}</button>
          </form>
        </section>}
      </section>}
      <section className="kh-learning__sources" aria-label="Official sources">
        <h3>Official sources</h3><ul>{open.sources.map(source => <li key={source.url}>
          <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></li>)}</ul>
        <p className="kh-learning__meta">Sources checked {when(open.checkedAt)}. AI-reviewed, not a guarantee of correctness.</p>
      </section>
      <details className="kh-learning__report"><summary>Report a question or explanation</summary>
        <p>Reporting immediately withholds this question from quizzes. It will not silently change your submitted answer.</p>
        <form onSubmit={event => { event.preventDefault(); void run(async () => {
          requireApiData(await api.learningReport(sessionId, position, report)); setReport(''); await refresh();
        }); }}>
          <label className="kh-uc-field"><span className="kh-uc-field__label">What seems incorrect or unclear?</span>
            <textarea className="kh-uc-input kh-uc-input--area" rows={3} maxLength={2000} value={report} disabled={busy}
              onChange={event => { setReport(event.target.value); }} /></label>
          <button type="submit" className="kh-btn-ghost" disabled={busy || !report.trim()}>Report and withhold</button>
        </form>
      </details>
      {(open.review || open.skipped) && <div className="kh-learning__actions"><button type="button" className="kh-btn-accent"
        disabled={busy} onClick={onNext}>{position === questionCount - 1 ? 'Finish session' : 'Next question'}</button></div>}
    </>}
    {error && <p className="kh-learning__error" role="alert">{error}</p>}
  </section>;
};

export const LearningPage: React.FC = () => {
  const [params, writeParams] = useSearchParams();
  const location = useLocation();
  const setParams = (next: Record<string, string>): void => { writeParams(next, { state: location.state, replace: true }); };
  const sessionId = params.get('session') ?? '';
  const questionParam = params.get('question');
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const overview = useQuery({ queryKey: ['learning-overview'], queryFn: async () => requireApiData(await api.learningOverview()), retry: false });
  const session = useQuery({ queryKey: ['learning-session', sessionId], enabled: !!sessionId, retry: false,
    queryFn: async () => requireApiData(await api.learningSession(sessionId)),
    refetchInterval: query => query.state.data?.status === 'preparing' ? 5000 : false });
  const jobs = useQuery({ queryKey: ['learning-jobs', sessionId], enabled: !!sessionId && session.data?.status !== 'ready',
    queryFn: async () => requireApiData(await api.learningJobs(sessionId)), retry: false,
    refetchInterval: query => session.data?.status === 'preparing' || query.state.data?.some(job => job.status === 'queued' || job.status === 'running') ? 5000 : false });
  const items = session.data?.items ?? [];
  const questionCount = session.data?.questionCount ?? 10;
  const validPosition = questionParam !== null && /^[0-9]$/.test(questionParam) && Number(questionParam) < questionCount;
  const activePosition = validPosition ? Number(questionParam)
    : items.find(item => !item.answered && !item.skipped)?.position ?? 0;
  useEffect(() => {
    if (sessionId && session.data?.status === 'ready' && !validPosition) {
      writeParams({ session: sessionId, question: String(activePosition) }, { state: location.state, replace: true });
    }
  }, [sessionId, session.data?.status, validPosition, activePosition, location.state, writeParams]);
  const activeJob = jobs.data?.find(job => job.status === 'queued' || job.status === 'running');
  const latestJob = activeJob ?? jobs.data?.[0];
  const preparationFailed = session.data?.status !== 'ready' && !activeJob && (session.data?.status === 'failed' || latestJob?.status === 'failed');
  const preparing = !!sessionId && !preparationFailed && (session.data?.status === 'preparing' || !!activeJob);
  const start = async (): Promise<void> => {
    setBusy(true); setError(null);
    try { const next = requireApiData(await api.startLearning()); setParams({ session: next.id }); await cache.invalidateQueries({ queryKey: ['learning-overview'] }); }
    catch (err) { setError(describeApiError(err)); }
    finally { setBusy(false); }
  };
  return <section className="kh-learning" aria-label="Quick learning quiz">
    {sessionId ? <>
      <button className="kh-btn-ghost" type="button" onClick={() => { setParams({}); void overview.refetch(); }}>Back to sessions</button>
      {session.isPending && <p role="status">Loading your saved session...</p>}
      {session.isError && <DataNotice title="Session could not be loaded" error={session.error} onRetry={() => { void session.refetch(); }} busy={session.isFetching} />}
      {preparing && <section className="kh-learning__preparing" aria-live="polite"><h2>Preparing your questions</h2>
        <p>{latestJob?.progress.at(-1) ?? 'Fetching official documentation and checking the questions in the background...'}</p>
        <p>You can leave this page. The session will be saved here when ready.</p></section>}
      {jobs.isError && preparing && <DataNotice title="Preparation progress unavailable" error={jobs.error} onRetry={() => { void jobs.refetch(); }} busy={jobs.isFetching} />}
      {preparationFailed && <section className="kh-learning__withheld" role="alert">
        <h2>No unchecked questions will be shown</h2><p>{session.data?.error ?? 'Question preparation could not finish.'}</p>
        {latestJob?.error && <p>{latestJob.error}</p>}
        <button className="kh-btn-accent" type="button" disabled={busy} onClick={() => { void (async () => {
          setBusy(true); setError(null);
          try { requireApiData(await api.prepareLearning(sessionId)); await Promise.all([session.refetch(), jobs.refetch()]); }
          catch (err) { setError(describeApiError(err)); }
          finally { setBusy(false); }
        })(); }}>Retry preparation</button>
      </section>}
      {session.data?.status === 'ready' && <LearningQuestion key={`${sessionId}-${activePosition}`} sessionId={sessionId} position={activePosition} questionCount={questionCount}
        onNext={() => {
          if (activePosition < questionCount - 1) setParams({ session: sessionId, question: String(activePosition + 1) });
          else { setParams({}); void overview.refetch(); }
        }} />}
    </> : <>
      <p>Ten questions. Microsoft and GitHub. Strategy, enablement and products—not code debugging.</p>
      <p className="kh-learning__intro">Official documentation only. Questions and explanations are evidence-checked, with live source checks before use.
        Uncertain or changed questions are withheld. Your answers and discussions are saved.</p>
      <section className="kh-learning__daily" aria-label="Daily learning test"><h2>Daily test</h2>
        <p>Prepared at 10pm UK time, Sunday–Thursday nights, ready for Monday–Friday mornings.</p>
        {overview.data?.schedule.automatic === false && <p className="kh-learning__meta">Automatic overnight preparation runs in production; it is disabled on this local server.</p>}
        {overview.data?.daily.map(daily => <div className="kh-learning__daily-entry" key={daily.id}><div>
          <strong>{dayLabel(daily.dailyFor)}</strong><p className="kh-learning__meta">{daily.total} questions · {daily.status === 'ready' ? 'Ready' : daily.status === 'preparing' ? 'Preparing in the background' : 'Preparation needs attention'}</p>
          {daily.error && <p className="kh-learning__error">{daily.error}</p>}</div>
          <button type="button" className="kh-btn-ghost" onClick={() => { setParams({ session: daily.id }); }}>{daily.status === 'ready' ? 'Open test' : 'View preparation'}</button>
        </div>)}
        {overview.data && !overview.data.daily.length && <p className="kh-learning__meta">No scheduled test is available yet. You can start a test now.</p>}
        <div className="kh-learning__actions"><button className="kh-btn-accent" type="button" disabled={busy || overview.isPending}
          onClick={() => { void start(); }}>{busy ? 'Starting...' : 'Start or resume a test'}</button></div>
      </section>
      {overview.data && <TopicProgress topics={overview.data.topics} onReview={(id, position) => { setParams({ session: id, question: String(position) }); }} />}
      <section className="kh-learning__history" aria-label="Saved learning sessions"><h2>Your sessions</h2>
        {overview.isPending && <p role="status">Loading learning history...</p>}
        {overview.isError && <DataNotice title="Learning history could not be loaded" error={overview.error} onRetry={() => { void overview.refetch(); }} busy={overview.isFetching} />}
        {overview.data?.sessions.length === 0 && <p>No sessions yet. Start ten questions when you have a few minutes.</p>}
        <ul>{overview.data?.sessions.map(saved => <li key={saved.id}><div>
          <strong>{saved.dailyFor ? `Daily test · ${dayLabel(saved.dailyFor)}` : when(saved.createdAt)}</strong><p>{saved.status === 'preparing' ? 'Preparing questions' : saved.status === 'failed' ? 'Preparation needs attention'
            : `${saved.answered}/${saved.total} answered · ${saved.correct} correct${saved.skipped ? ` · ${saved.skipped} skipped` : ''}${saved.answered + saved.skipped === saved.total ? ' · Finished' : ''}`}</p></div>
          <button type="button" className="kh-btn-ghost" onClick={() => { setParams({ session: saved.id }); }}>
            {saved.answered + saved.skipped === saved.total ? 'Review' : 'Resume'}</button>
        </li>)}</ul>
      </section>
    </>}
    {error && <p className="kh-learning__error" role="alert">{error}</p>}
  </section>;
};

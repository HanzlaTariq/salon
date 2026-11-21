import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'customers_screen.dart';
import 'reviews_api.dart';
import 'reviews_models.dart';
import 'reviews_widgets.dart';

/// Owner: reviews of the salon with the rating summary, filters, the public response and "report to the platform".
class OwnerReviewsScreen extends StatefulWidget {
  const OwnerReviewsScreen({super.key, required this.api});
  final ReviewsApi api;

  @override
  State<OwnerReviewsScreen> createState() => _OwnerReviewsScreenState();
}

class _OwnerReviewsScreenState extends State<OwnerReviewsScreen> {
  bool _unanswered = false;
  int? _stars;
  late Future<OwnerSummary> _summary = widget.api.summary();
  final List<OwnerReview> _items = [];
  int _page = 0;
  bool _hasMore = false;
  bool _loading = true;
  bool _loadingMore = false;
  ApiException? _error;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    setState(() {
      _loading = true;
      _error = null;
      _summary = widget.api.summary();
    });
    try {
      final p = await widget.api.reviews(unansweredOnly: _unanswered, rating: _stars);
      if (!mounted) return;
      setState(() {
        _items
          ..clear()
          ..addAll(p.items);
        _page = p.page;
        _hasMore = p.hasMore;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e);
    } catch (_) {
      if (mounted) setState(() => _error = ApiException.network());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _more() async {
    setState(() => _loadingMore = true);
    try {
      final p = await widget.api.reviews(page: _page + 1, unansweredOnly: _unanswered, rating: _stars);
      if (!mounted) return;
      setState(() {
        _items.addAll(p.items);
        _page = p.page;
        _hasMore = p.hasMore;
      });
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  Future<void> _respond(OwnerReview r) async {
    final text = await showModalBottomSheet<String>(context: context, isScrollControlled: true, builder: (_) => _ResponseSheet(initial: r.response));
    if (text == null) return;
    try {
      await widget.api.respond(r.id, text);
      if (mounted) _reload();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  Future<void> _removeResponse(OwnerReview r) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Remove your response?'),
        content: const Text('The review stays public; only your reply is removed.'),
        actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep')), FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Remove'))],
      ),
    );
    if (ok != true) return;
    try {
      await widget.api.removeResponse(r.id);
      if (mounted) _reload();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  Future<void> _report(OwnerReview r) async {
    final result = await showModalBottomSheet<(String, String)>(context: context, isScrollControlled: true, builder: (_) => const _ReportSheet());
    if (result == null) return;
    try {
      await widget.api.report(r.id, reason: result.$1, details: result.$2);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Reported. Our team will review it.')));
      _reload();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Reviews'),
        actions: [IconButton(tooltip: 'Customers', icon: const Icon(Icons.people_outline), onPressed: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => CustomersScreen(api: widget.api))))],
      ),
      body: _loading && _items.isEmpty
          ? const LoadingView(label: 'Loading reviews…')
          : _error != null && _items.isEmpty
              ? ErrorView(message: _error!.message, requestId: _error!.requestId, onRetry: _reload)
              : RefreshIndicator(
                  onRefresh: _reload,
                  child: ListView(padding: const EdgeInsets.all(AppSpacing.lg), children: [
                    FutureBuilder<OwnerSummary>(
                      future: _summary,
                      builder: (_, snap) => snap.hasData ? RatingHeader(rating: snap.data!.rating, unanswered: snap.data!.unanswered) : const SizedBox(height: 120, child: LoadingView()),
                    ),
                    FutureBuilder<OwnerSummary>(
                      future: _summary,
                      builder: (_, snap) => snap.hasData && snap.data!.staff.isNotEmpty
                          ? Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              const SizedBox(height: AppSpacing.lg),
                              Text('By staff member', style: theme.textTheme.titleMedium),
                              for (final s in snap.data!.staff)
                                ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text(s.name), trailing: Row(mainAxisSize: MainAxisSize.min, children: [Stars(rating: s.rating.average, size: 14), const SizedBox(width: AppSpacing.sm), Text(ratingText(s.rating.average, s.rating.count), style: theme.textTheme.bodySmall)])),
                            ])
                          : const SizedBox.shrink(),
                    ),
                    const SizedBox(height: AppSpacing.lg),
                    Wrap(spacing: AppSpacing.sm, runSpacing: AppSpacing.xs, children: [
                      FilterChip(label: const Text('To answer'), selected: _unanswered, onSelected: (v) { _unanswered = v; _reload(); }),
                      for (var s = 5; s >= 1; s--)
                        ChoiceChip(label: Text('$s ★'), selected: _stars == s, onSelected: (v) { _stars = v ? s : null; _reload(); }),
                    ]),
                    const SizedBox(height: AppSpacing.md),
                    if (_items.isEmpty)
                      const Padding(padding: EdgeInsets.all(AppSpacing.xl), child: Center(child: Text('No reviews match.')))
                    else
                      for (final r in _items) Padding(padding: const EdgeInsets.only(bottom: AppSpacing.md), child: _ReviewCard(review: r, onRespond: () => _respond(r), onRemove: () => _removeResponse(r), onReport: () => _report(r))),
                    if (_hasMore) OutlinedButton(onPressed: _loadingMore ? null : _more, child: _loadingMore ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('Show more')),
                  ]),
                ),
    );
  }
}

class _ReviewCard extends StatelessWidget {
  const _ReviewCard({required this.review, required this.onRespond, required this.onRemove, required this.onReport});
  final OwnerReview review;
  final VoidCallback onRespond;
  final VoidCallback onRemove;
  final VoidCallback onReport;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text(review.authorName, style: theme.textTheme.titleSmall)),
            Text(dateText(review.createdAt) + (review.edited ? ' · edited' : ''), style: theme.textTheme.bodySmall?.copyWith(color: AppColors.mutedText)),
          ]),
          const SizedBox(height: AppSpacing.xs),
          Stars(rating: review.rating.toDouble()),
          if (review.staffRating != null && review.staffName != null) ...[
            const SizedBox(height: AppSpacing.xs),
            Row(children: [Text('${review.staffName}  ', style: theme.textTheme.bodySmall), Stars(rating: review.staffRating!.toDouble(), size: 13)]),
          ],
          if (review.comment != null) ...[const SizedBox(height: AppSpacing.sm), Text(review.comment!)],
          if (review.services.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.sm),
            Text(review.services.map((s) => '${s.name} ${s.rating}/5').join(' · '), style: theme.textTheme.bodySmall?.copyWith(color: AppColors.mutedText)),
          ],
          if (review.response != null) ...[
            const SizedBox(height: AppSpacing.md),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(AppSpacing.md),
              decoration: BoxDecoration(color: AppColors.sand, borderRadius: BorderRadius.circular(AppRadius.input)),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Your response', style: theme.textTheme.labelMedium?.copyWith(color: AppColors.ink)),
                Text(review.response!, style: theme.textTheme.bodyMedium?.copyWith(color: AppColors.ink)),
              ]),
            ),
          ],
          const SizedBox(height: AppSpacing.sm),
          Wrap(spacing: AppSpacing.sm, children: [
            TextButton.icon(onPressed: onRespond, icon: const Icon(Icons.reply, size: 18), label: Text(review.response == null ? 'Respond' : 'Edit response')),
            if (review.response != null) TextButton(onPressed: onRemove, child: const Text('Remove response')),
            if (review.reported)
              const Chip(label: Text('Reported'), avatar: Icon(Icons.flag_outlined, size: 16))
            else
              TextButton.icon(onPressed: onReport, icon: const Icon(Icons.flag_outlined, size: 18), label: const Text('Report')),
          ]),
        ]),
      ),
    );
  }
}

class _ResponseSheet extends StatefulWidget {
  const _ResponseSheet({this.initial});
  final String? initial;

  @override
  State<_ResponseSheet> createState() => _ResponseSheetState();
}

class _ResponseSheetState extends State<_ResponseSheet> {
  late final TextEditingController _c = TextEditingController(text: widget.initial ?? '');
  bool _touched = false;

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final problem = _touched ? textProblem(_c.text, max: kResponseMax) : null;
    return Padding(
      padding: EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.lg, AppSpacing.lg, MediaQuery.of(context).viewInsets.bottom + AppSpacing.lg),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Respond publicly', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: AppSpacing.xs),
        Text('Everyone who reads this review will see your answer. Be polite and do not share private details.', style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: AppSpacing.md),
        TextField(controller: _c, maxLines: 5, minLines: 3, maxLength: kResponseMax, autofocus: true, textCapitalization: TextCapitalization.sentences, decoration: InputDecoration(labelText: 'Your response', errorText: problem), onChanged: (_) => setState(() => _touched = true)),
        const SizedBox(height: AppSpacing.sm),
        FilledButton(
          onPressed: () {
            setState(() => _touched = true);
            if (textProblem(_c.text, max: kResponseMax) == null) Navigator.pop(context, _c.text.trim());
          },
          child: const Text('Publish response'),
        ),
      ]),
    );
  }
}

class _ReportSheet extends StatefulWidget {
  const _ReportSheet();

  @override
  State<_ReportSheet> createState() => _ReportSheetState();
}

class _ReportSheetState extends State<_ReportSheet> {
  String? _reason;
  final TextEditingController _details = TextEditingController();
  bool _touched = false;

  @override
  void dispose() {
    _details.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final needsDetails = _reason == 'OTHER';
    final detailsProblem = _touched ? textProblem(_details.text, max: kReportDetailsMax, required: needsDetails) : null;
    return SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(AppSpacing.lg, AppSpacing.lg, AppSpacing.lg, MediaQuery.of(context).viewInsets.bottom + AppSpacing.lg),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Report this review', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: AppSpacing.xs),
        Text('Our team checks reviews that break the rules. A review is not removed just because it is negative.', style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: AppSpacing.md),
        for (final e in kReportReasons.entries)
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(e.value),
            leading: Icon(_reason == e.key ? Icons.radio_button_checked : Icons.radio_button_unchecked),
            onTap: () => setState(() => _reason = e.key),
          ),
        TextField(controller: _details, maxLines: 3, maxLength: kReportDetailsMax, decoration: InputDecoration(labelText: needsDetails ? 'What is wrong?' : 'Details (optional)', errorText: detailsProblem), onChanged: (_) => setState(() => _touched = true)),
        const SizedBox(height: AppSpacing.sm),
        FilledButton(
          onPressed: _reason == null
              ? null
              : () {
                  setState(() => _touched = true);
                  if (textProblem(_details.text, max: kReportDetailsMax, required: needsDetails) == null) Navigator.pop(context, (_reason!, _details.text.trim()));
                },
          child: const Text('Send report'),
        ),
      ]),
    );
  }
}

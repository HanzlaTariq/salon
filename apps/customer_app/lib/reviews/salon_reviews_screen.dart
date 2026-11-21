import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'review_api.dart';
import 'review_models.dart';
import 'review_widgets.dart';

/// Public reviews of one salon: summary, rating per staff member, sorting and "load more".
class SalonReviewsScreen extends StatefulWidget {
  const SalonReviewsScreen({super.key, required this.api, required this.salonId, required this.salonName});
  final ReviewApi api;
  final String salonId;
  final String salonName;

  @override
  State<SalonReviewsScreen> createState() => _SalonReviewsScreenState();
}

const _sorts = {'recent': 'Newest', 'highest': 'Highest rated', 'lowest': 'Lowest rated'};

class _SalonReviewsScreenState extends State<SalonReviewsScreen> {
  String _sort = 'recent';
  SalonReviewsPage? _first;
  final List<PublicReview> _items = [];
  int _page = 1;
  bool _hasMore = false;
  bool _loading = true;
  bool _loadingMore = false;
  ApiException? _error;
  String? _moreError;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
      _moreError = null;
    });
    try {
      final page = await widget.api.salonReviews(widget.salonId, sort: _sort);
      if (!mounted) return;
      setState(() {
        _first = page;
        _items
          ..clear()
          ..addAll(page.items);
        _page = page.page;
        _hasMore = page.hasMore;
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
    setState(() {
      _loadingMore = true;
      _moreError = null;
    });
    try {
      final page = await widget.api.salonReviews(widget.salonId, sort: _sort, page: _page + 1);
      if (!mounted) return;
      setState(() {
        _items.addAll(page.items);
        _page = page.page;
        _hasMore = page.hasMore;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _moreError = e.message);
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: Text('Reviews · ${widget.salonName}', overflow: TextOverflow.ellipsis)),
      body: _loading && _first == null
          ? const LoadingView(label: 'Loading reviews…')
          : _error != null && _first == null
              ? ErrorView(message: _error!.statusCode == 404 ? 'This salon is not available right now.' : _error!.message, requestId: _error!.requestId, onRetry: _load)
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView(padding: const EdgeInsets.all(AppSpacing.lg), children: [
                    RatingSummaryCard(summary: _first?.summary ?? RatingSummary.empty),
                    if (_first != null && _first!.staff.isNotEmpty) ...[
                      const SizedBox(height: AppSpacing.lg),
                      Text('By staff member', style: theme.textTheme.titleMedium),
                      for (final s in _first!.staff)
                        ListTile(
                          dense: true,
                          contentPadding: EdgeInsets.zero,
                          title: Text(s.name),
                          trailing: Row(mainAxisSize: MainAxisSize.min, children: [StarRow(rating: s.summary.average, size: 14), const SizedBox(width: AppSpacing.sm), Text(ratingLabel(s.summary.average, s.summary.count), style: theme.textTheme.bodySmall)]),
                        ),
                    ],
                    const SizedBox(height: AppSpacing.lg),
                    Wrap(spacing: AppSpacing.sm, children: [
                      for (final e in _sorts.entries)
                        ChoiceChip(label: Text(e.value), selected: _sort == e.key, onSelected: (_) {
                          if (_sort == e.key) return;
                          _sort = e.key;
                          _load();
                        }),
                    ]),
                    const SizedBox(height: AppSpacing.md),
                    if (_items.isEmpty && (_first?.summary.count ?? 0) == 0)
                      const Padding(padding: EdgeInsets.all(AppSpacing.xl), child: Center(child: Text('Reviews from customers appear here after their visit.')))
                    else
                      for (final r in _items) Padding(padding: const EdgeInsets.only(bottom: AppSpacing.md), child: PublicReviewCard(review: r)),
                    if (_moreError != null) Text(_moreError!, style: theme.textTheme.bodySmall?.copyWith(color: AppColors.danger)),
                    if (_hasMore) OutlinedButton(onPressed: _loadingMore ? null : _more, child: _loadingMore ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('Show more reviews')),
                  ]),
                ),
    );
  }
}

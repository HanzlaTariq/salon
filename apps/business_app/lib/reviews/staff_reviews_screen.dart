import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'reviews_api.dart';
import 'reviews_models.dart';
import 'reviews_widgets.dart';

/// Staff: reviews about their OWN work (the server derives the staff member from the session; nothing about colleagues is shown).
class StaffReviewsScreen extends StatefulWidget {
  const StaffReviewsScreen({super.key, required this.api});
  final ReviewsApi api;

  @override
  State<StaffReviewsScreen> createState() => _StaffReviewsScreenState();
}

class _StaffReviewsScreenState extends State<StaffReviewsScreen> {
  Rating _rating = Rating.empty;
  final List<StaffReview> _items = [];
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
    });
    try {
      final p = await widget.api.myStaffReviews();
      if (!mounted) return;
      setState(() {
        _rating = p.rating;
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
      final p = await widget.api.myStaffReviews(page: _page + 1);
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

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('My reviews')),
      body: _loading && _items.isEmpty
          ? const LoadingView(label: 'Loading your reviews…')
          : _error != null && _items.isEmpty
              ? ErrorView(message: _error!.message, requestId: _error!.requestId, onRetry: _reload)
              : RefreshIndicator(
                  onRefresh: _reload,
                  child: ListView(padding: const EdgeInsets.all(AppSpacing.lg), children: [
                    RatingHeader(rating: _rating),
                    Padding(padding: const EdgeInsets.only(top: AppSpacing.xs), child: Text('The average counts your own rating only; a review without a rating for you is listed but not counted.', style: theme.textTheme.bodySmall?.copyWith(color: AppColors.mutedText))),
                    const SizedBox(height: AppSpacing.md),
                    if (_items.isEmpty)
                      const Padding(padding: EdgeInsets.all(AppSpacing.xl), child: Center(child: Text('Customers who finish a visit with you can review it.')))
                    else
                      for (final r in _items)
                        Card(
                          child: Padding(
                            padding: const EdgeInsets.all(AppSpacing.lg),
                            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Row(children: [Expanded(child: Text(r.authorName, style: theme.textTheme.titleSmall)), Text(dateText(r.visitAt), style: theme.textTheme.bodySmall)]),
                              const SizedBox(height: AppSpacing.xs),
                              r.staffRating == null ? Text('No rating for you', style: theme.textTheme.bodySmall) : Stars(rating: r.staffRating!.toDouble()),
                              if (r.comment != null) ...[const SizedBox(height: AppSpacing.sm), Text(r.comment!)],
                              if (r.services.isNotEmpty) Padding(padding: const EdgeInsets.only(top: AppSpacing.sm), child: Text(r.services.map((s) => s.name).join(' · '), style: theme.textTheme.bodySmall?.copyWith(color: AppColors.mutedText))),
                            ]),
                          ),
                        ),
                    if (_hasMore) OutlinedButton(onPressed: _loadingMore ? null : _more, child: Text(_loadingMore ? 'Loading…' : 'Show more')),
                  ]),
                ),
    );
  }
}
